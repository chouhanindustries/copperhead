// LLM-backed FactExtractor (design D9). Reads digitised pages against the
// field list and reports raw fields with per-field confidence and verbatim
// snippets. The extractor is untrusted: the core pipeline verifies every
// snippet against the digitised text and stitches bboxes deterministically,
// so nothing returned here can become a trusted fact on its own say-so.

import Anthropic from "@anthropic-ai/sdk";
import { FieldSpec } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { ExtractionError, FactExtractor } from "../ports/extractor";

const DEFAULT_MODEL = "claude-opus-5";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "page", "snippet", "confidence"],
        properties: {
          field: { type: "string", description: "The field label as asked for" },
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
            description: "The numeric value as printed (before unit conversion), or a string when not a single number",
          },
          unit: { type: "string", description: "Unit exactly as printed in the datasheet, e.g. mA" },
          page: { type: "integer", description: "1-based page number the value was read from" },
          snippet: {
            type: "string",
            description: "Short VERBATIM excerpt from the digitised text containing the value. Copy it exactly; do not paraphrase.",
          },
          footnoteQualified: {
            type: "boolean",
            description: "True when the value carries a footnote marker or conditional qualifier",
          },
          confidence: {
            type: "number",
            description: "0..1 confidence that the value, unit, and location are all correct",
          },
        },
      },
    },
  },
} as const;

function buildPrompt(pages: DigitisedPage[], specs: FieldSpec[]): string {
  const pageText = pages
    .map((p) => `<page number="${p.page}">\n${p.text}\n</page>`)
    .join("\n\n");
  const fieldList = specs.map((s) => `- ${s.prompt}`).join("\n");
  return [
    "You are extracting electrical parameters from a digitised component datasheet.",
    "Extract the following fields:",
    fieldList,
    "",
    "Rules:",
    "- Only report a field if its value appears in the digitised text below.",
    "- snippet must be copied verbatim from the text (it will be checked literally; a paraphrased snippet voids the field).",
    "- Report the value and unit exactly as printed; do not convert units.",
    "- If a value is qualified by a footnote marker or test condition that changes its meaning, set footnoteQualified true.",
    "- confidence reflects how sure you are the value, unit, and page are all correct. Use low confidence (<0.75) when the text is garbled, ambiguous, or the field label is a loose match.",
    "- Omit fields you cannot find. Do not guess.",
    "",
    "Digitised datasheet text:",
    pageText,
  ].join("\n");
}

function isValidField(raw: unknown): raw is RawExtractedField & { field: string } {
  if (typeof raw !== "object" || raw === null) return false;
  const f = raw as Record<string, unknown>;
  return (
    typeof f.field === "string" &&
    (typeof f.value === "number" || typeof f.value === "string") &&
    typeof f.page === "number" &&
    Number.isInteger(f.page) &&
    typeof f.snippet === "string" &&
    typeof f.confidence === "number" &&
    f.confidence >= 0 &&
    f.confidence <= 1
  );
}

export class LlmExtractor implements FactExtractor {
  readonly modelId: string;
  private readonly client: Anthropic;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.modelId = options.model ?? process.env.INTAKE_EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
  }

  async extract(pages: DigitisedPage[], specs: FieldSpec[]): Promise<RawExtractedField[]> {
    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: buildPrompt(pages, specs) }],
    });

    if (response.stop_reason === "refusal") {
      throw new ExtractionError("extractor model declined the request (refusal)");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new ExtractionError("extractor returned no text content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch (err) {
      throw new ExtractionError(
        `extractor output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const fields = (parsed as { fields?: unknown[] }).fields;
    if (!Array.isArray(fields)) {
      throw new ExtractionError("extractor output has no fields array");
    }
    // Defensive re-validation; malformed entries are dropped, never guessed at.
    return fields.filter(isValidField).map((f) => {
      const out: RawExtractedField = {
        field: f.field,
        value: f.value,
        page: f.page,
        snippet: f.snippet,
        confidence: f.confidence,
      };
      if (typeof f.unit === "string") out.unit = f.unit;
      if (typeof f.footnoteQualified === "boolean") out.footnoteQualified = f.footnoteQualified;
      return out;
    });
  }
}
