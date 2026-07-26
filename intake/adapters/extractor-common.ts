// Shared between the API-backed and Claude Code-backed extractors: the
// extraction prompt and the defensive re-validation of model output.
// Both implementations are untrusted by construction; the core pipeline
// verifies snippets and stitches bboxes regardless of which one ran.

import { FieldSpec } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { ExtractionError } from "../ports/extractor";

export function buildExtractionPrompt(pages: DigitisedPage[], specs: FieldSpec[]): string {
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

export function isValidField(raw: unknown): raw is RawExtractedField & { field: string } {
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

/** Validate a parsed `{ fields: [...] }` payload, dropping malformed entries. */
export function toRawFields(parsed: unknown): RawExtractedField[] {
  const fields = (parsed as { fields?: unknown[] })?.fields;
  if (!Array.isArray(fields)) {
    throw new ExtractionError("extractor output has no fields array");
  }
  return fields.filter(isValidField).map((f) => {
    const out: RawExtractedField = {
      field: f.field,
      value: f.value,
      page: f.page,
      snippet: f.snippet,
      confidence: f.confidence,
    };
    const rec = f as unknown as Record<string, unknown>;
    if (typeof rec.unit === "string") out.unit = rec.unit;
    if (typeof rec.footnoteQualified === "boolean") out.footnoteQualified = rec.footnoteQualified;
    return out;
  });
}

/** Parse JSON out of a model reply that may wrap it in fences or prose. */
export function parseJsonReply(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ExtractionError("extractor reply contains no JSON object");
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    throw new ExtractionError(
      `extractor reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
