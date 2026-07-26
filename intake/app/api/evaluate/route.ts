import { NextRequest, NextResponse } from "next/server";
import { evaluate } from "../../../core/engine";
import { buildManifest } from "../../../core/manifest";
import { ChangeDescriptor, ExtractedFact } from "../../../core/model";
import { RegistryError } from "../../../core/registry";
import { registryStore } from "../../../lib/server";

export const runtime = "nodejs";

interface EvaluateBody {
  descriptor: ChangeDescriptor;
  /** Freshly ingested facts (optional); stored registry facts take precedence per key. */
  facts?: ExtractedFact[];
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as EvaluateBody;
  if (!body?.descriptor?.label || !Array.isArray(body.descriptor.contributions)) {
    return NextResponse.json({ error: "invalid change descriptor" }, { status: 400 });
  }

  const store = registryStore();
  let registry;
  try {
    registry = store.load();
  } catch (err) {
    // Fail closed: a malformed registry refuses to evaluate (AC-5.2).
    return NextResponse.json(
      { error: err instanceof RegistryError ? err.message : "registry unreadable" },
      { status: 422 },
    );
  }

  // Stored facts win (reuse, AC-8.2); fresh ingested facts fill the gaps.
  const merged: ExtractedFact[] = [...registry.facts];
  for (const fact of body.facts ?? []) {
    if (!merged.some((f) => f.key === fact.key)) merged.push(fact);
  }

  const { verdict, checksRun, factsUsed } = evaluate(body.descriptor, merged, registry.constraints);

  if (verdict.decision === "APPROVE" || verdict.decision === "REFUSE") {
    store.persistFacts(factsUsed);
  }

  const manifest = buildManifest({
    timestampISO: new Date().toISOString(),
    part: registry.part,
    descriptor: body.descriptor,
    constraints: registry.constraints,
    checksRun,
    factsUsed,
    verdict,
    digitiseModel: "sarvam-vision",
    extractorModel: process.env.INTAKE_EXTRACTOR_MODEL ?? "claude-opus-5",
  });

  return NextResponse.json({ verdict, manifest });
}
