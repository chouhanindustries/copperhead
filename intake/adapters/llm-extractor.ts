// API-backed FactExtractor (design D9): claude-opus-5 through the
// Anthropic SDK with structured outputs, so the reply is schema-valid
// JSON. The extractor is untrusted: the core pipeline verifies every
// snippet against the digitised text and stitches bboxes
// deterministically, so nothing returned here can become a trusted fact
// on its own say-so.

import Anthropic from "@anthropic-ai/sdk";
import { FieldSpec } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { ExtractionError, FactExtractor } from "../ports/extractor";
import { buildExtractionPrompt, toRawFields } from "./extractor-common";

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

export class LlmExtractor implements FactExtractor {
  readonly modelId: string;
  private readonly client: Anthropic;

  private readonly onProgress: (message: string) => void;

  constructor(options: { apiKey?: string; model?: string; onProgress?: (message: string) => void } = {}) {
    this.modelId = options.model ?? process.env.INTAKE_EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
    this.onProgress = options.onProgress ?? (() => {});
  }

  async extract(pages: DigitisedPage[], specs: FieldSpec[]): Promise<RawExtractedField[]> {
    this.onProgress(`asking ${this.modelId} for ${specs.length} fields (structured output, verbatim snippets)`);
    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: buildExtractionPrompt(pages, specs) }],
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
    return toRawFields(parsed);
  }
}
