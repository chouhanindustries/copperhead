import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { digitiseCacheKey, extractCacheKey, JsonCache } from "../adapters/cache";
import { FixtureDigitisationProvider, FixtureExtractor } from "../adapters/fixtures";
import { ingest, IngestDeps } from "../adapters/ingest";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { DigitisedPage, RawExtractedField } from "../core/pipeline";
import { DocumentInput } from "../ports/digitisation";
import { digitisedPage, rawField } from "./helpers";

const doc: DocumentInput = { fileName: "demo.pdf", bytes: Buffer.from("fake pdf bytes") };

function fixtureDeps(dir: string): IngestDeps {
  const cache = new JsonCache(dir);
  return {
    cache,
    digitiser: new FixtureDigitisationProvider(cache),
    extractor: new FixtureExtractor(cache, doc.bytes),
  };
}

describe("ingest with fixtures (AC-12.2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intake-cache-"));
    const cache = new JsonCache(dir);
    cache.write(digitiseCacheKey(doc.bytes), [digitisedPage()] satisfies DigitisedPage[]);
    cache.write(
      extractCacheKey(doc.bytes, DEFAULT_FIELD_SPECS),
      [rawField()] satisfies RawExtractedField[],
    );
  });

  it("serves cached digitise and extract JSON with no live provider", async () => {
    const result = await ingest(doc, fixtureDeps(dir));
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.status).toBe("trusted");
    expect(result.digitiseModel).toContain("fixtures");
  });

  it("never calls providers when the cache is warm (reuse, AC-8.2)", async () => {
    let digitiseCalls = 0;
    let extractCalls = 0;
    const cache = new JsonCache(dir);
    const deps: IngestDeps = {
      cache,
      digitiser: {
        modelId: "counting",
        digitise: async () => {
          digitiseCalls++;
          return [digitisedPage()];
        },
      },
      extractor: {
        modelId: "counting",
        extract: async () => {
          extractCalls++;
          return [rawField()];
        },
      },
    };
    await ingest(doc, deps);
    await ingest(doc, deps);
    expect(digitiseCalls).toBe(0);
    expect(extractCalls).toBe(0);
  });

  it("calls each provider exactly once on a cold cache, then reuses", async () => {
    const coldDir = mkdtempSync(join(tmpdir(), "intake-cold-"));
    let digitiseCalls = 0;
    let extractCalls = 0;
    const deps: IngestDeps = {
      cache: new JsonCache(coldDir),
      digitiser: {
        modelId: "counting",
        digitise: async () => {
          digitiseCalls++;
          return [digitisedPage()];
        },
      },
      extractor: {
        modelId: "counting",
        extract: async () => {
          extractCalls++;
          return [rawField()];
        },
      },
    };
    await ingest(doc, deps);
    await ingest(doc, deps);
    await ingest(doc, deps);
    expect(digitiseCalls).toBe(1);
    expect(extractCalls).toBe(1);
  });

  it("fails closed when fixtures are missing", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "intake-empty-"));
    await expect(ingest(doc, fixtureDeps(emptyDir))).rejects.toThrow(/no digitise fixture/);
  });
});
