import { NextRequest } from "next/server";
import { buildIngestDeps, ingest, IngestMode } from "../../../adapters/ingest";
import { FIXTURES_DIR, saveUpload } from "../../../lib/server";

export const runtime = "nodejs";

// Streams NDJSON progress events while ingesting:
//   {"t":"progress","message":"creating Sarvam digitise job"}
//   ...
//   {"t":"done","fileName":...,"pages":[...],"facts":[...]}
// or {"t":"error","error":"..."} as the terminal line.
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  const mode = form.get("mode");
  if (!(file instanceof File)) {
    return Response.json({ error: "no file uploaded" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  saveUpload(file.name, bytes);
  const doc = { fileName: file.name, bytes };
  const ingestMode: IngestMode | undefined =
    mode === "live" ? "live" : mode === "cached" ? "cached" : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      const onProgress = (message: string) => emit({ t: "progress", message });
      try {
        emit({ t: "progress", message: `received ${file.name} (${bytes.length} bytes)` });
        const opts = ingestMode ? { mode: ingestMode, onProgress } : { onProgress };
        const result = await ingest(doc, buildIngestDeps(doc, FIXTURES_DIR, opts), undefined, {
          refresh: ingestMode === "live",
          onProgress,
        });
        emit({
          t: "done",
          fileName: file.name,
          pages: result.pages,
          facts: result.facts,
          digitiseModel: result.digitiseModel,
          extractorModel: result.extractorModel,
        });
      } catch (err) {
        emit({
          t: "error",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
