import { NextRequest, NextResponse } from "next/server";
import { buildIngestDeps, ingest } from "../../../adapters/ingest";
import { DigitiseTimeoutError, DigitiseRateLimitError, DigitiseFailedError } from "../../../ports/digitisation";
import { ExtractionError } from "../../../ports/extractor";
import { FIXTURES_DIR, saveUpload } from "../../../lib/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  saveUpload(file.name, bytes);

  const doc = { fileName: file.name, bytes };
  try {
    const result = await ingest(doc, buildIngestDeps(doc, FIXTURES_DIR));
    return NextResponse.json({
      fileName: file.name,
      pages: result.pages,
      facts: result.facts,
      digitiseModel: result.digitiseModel,
      extractorModel: result.extractorModel,
    });
  } catch (err) {
    const status =
      err instanceof DigitiseTimeoutError || err instanceof DigitiseRateLimitError
        ? 503
        : err instanceof DigitiseFailedError || err instanceof ExtractionError
          ? 422
          : 500;
    return NextResponse.json(
      { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      { status },
    );
  }
}
