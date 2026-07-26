// Server-layer composition helpers for the Next.js routes.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryStore } from "../adapters/registry-store";

export const DATA_DIR = join(process.cwd(), "data");
export const FIXTURES_DIR = join(process.cwd(), "fixtures");
export const REGISTRY_PATH = join(DATA_DIR, "constraints.json");
const SEED_PATH = join(process.cwd(), "fixtures", "constraints.seed.json");

export function registryStore(): RegistryStore {
  // First run: seed the working registry from the committed starter.
  if (!existsSync(REGISTRY_PATH) && existsSync(SEED_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, readFileSync(SEED_PATH));
  }
  return new RegistryStore(REGISTRY_PATH);
}

export function saveUpload(fileName: string, bytes: Buffer): string {
  const dir = join(DATA_DIR, "uploads");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(path, bytes);
  return path;
}
