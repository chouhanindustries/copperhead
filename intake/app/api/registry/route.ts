import { NextRequest, NextResponse } from "next/server";
import { RegistryError } from "../../../core/registry";
import { registryStore } from "../../../lib/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(registryStore().load());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof RegistryError ? err.message : "registry unreadable" },
      { status: 422 },
    );
  }
}

/** Reset the working registry to the committed seed (demo housekeeping). */
export async function DELETE() {
  const { rmSync } = await import("node:fs");
  const { REGISTRY_PATH } = await import("../../../lib/server");
  rmSync(REGISTRY_PATH, { force: true });
  return NextResponse.json(registryStore().load());
}

/** Apply a user correction to a stored fact (AC-9.1). */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as { key?: string; value?: number | string };
  if (typeof body?.key !== "string" || (typeof body.value !== "number" && typeof body.value !== "string")) {
    return NextResponse.json({ error: "correction requires key and value" }, { status: 400 });
  }
  try {
    const registry = registryStore().correctFact(body.key, body.value);
    return NextResponse.json(registry);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof RegistryError ? err.message : "correction failed" },
      { status: 422 },
    );
  }
}
