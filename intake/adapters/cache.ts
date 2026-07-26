// Content-addressed cache for digitise and extractor results.
// A document is digitised once, ever; an LLM extraction runs at most once
// per (document, field list). Fixture mode reads the same files.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FieldSpec } from "../core/fields";

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fieldListHash(specs: FieldSpec[]): string {
  return sha256(JSON.stringify(specs.map((s) => [s.key, s.prompt, s.targetUnit ?? null]))).slice(0, 16);
}

export class JsonCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  read<T>(key: string): T | undefined {
    const file = this.path(key);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }

  /** Atomic write: temp file then rename. */
  write(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.path(key);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  }

  has(key: string): boolean {
    return existsSync(this.path(key));
  }
}

export function digitiseCacheKey(docBytes: Buffer): string {
  return `${sha256(docBytes)}.digitise`;
}

export function extractCacheKey(docBytes: Buffer, specs: FieldSpec[]): string {
  return `${sha256(docBytes)}-${fieldListHash(specs)}.extract`;
}
