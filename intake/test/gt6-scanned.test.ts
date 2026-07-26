// GT-6: the hard scanned source document (ON Semi 2N3055, a scanned-era
// datasheet with stamped tables). Its fixtures were captured from one live
// Sarvam + extractor run on 2026-07-26; this test replays that run offline
// through the committed content-addressed cache, exactly like cached demo
// mode. Acceptance: the document digitises with provenance intact, and the
// one uncertain extraction is flagged HOLD, so it can never decide a verdict.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonCache } from "../adapters/cache";
import { FixtureDigitisationProvider, FixtureExtractor } from "../adapters/fixtures";
import { ingest, IngestDeps } from "../adapters/ingest";
import { evaluate } from "../core/engine";
import { CONFIDENCE_THRESHOLD, ChangeDescriptor, Constraint } from "../core/model";
import { DocumentInput } from "../ports/digitisation";

const FIXTURES = join(process.cwd(), "fixtures");

const bytes = readFileSync(join(FIXTURES, "datasheets", "2n3055-scanned.pdf"));
const doc: DocumentInput = { fileName: "2n3055-scanned.pdf", bytes };

const constraints = (
  JSON.parse(readFileSync(join(FIXTURES, "constraints.seed.json"), "utf8")) as {
    constraints: Constraint[];
  }
).constraints;

function fixtureDeps(): IngestDeps {
  const cache = new JsonCache(join(FIXTURES, "cache"));
  return {
    cache,
    digitiser: new FixtureDigitisationProvider(cache),
    extractor: new FixtureExtractor(cache, bytes),
  };
}

const driveFromRail: ChangeDescriptor = {
  kind: "connect_rail",
  label: "drive the base pin from the 5V rail",
  contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
};

describe("GT-6: hard scanned document extracts with the uncertain region held", () => {
  it("digitises every page with regions and bounding boxes", async () => {
    const { pages } = await ingest(doc, fixtureDeps());
    expect(pages.length).toBe(5);
    for (const page of pages) {
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.regions.length).toBeGreaterThan(0);
      for (const region of page.regions) expect(region.bbox).toBeDefined();
    }
  });

  it("holds the uncertain abs-max read on the confidence gate, with provenance", async () => {
    const { facts } = await ingest(doc, fixtureDeps());
    expect(facts.length).toBeGreaterThan(0);

    const absMax = facts.find((f) => f.key === "abs_max_vin_V");
    expect(absMax).toBeDefined();
    expect(absMax?.status).toBe("hold");
    expect(absMax?.status === "hold" && absMax.holdReason).toMatch(/confidence 0\.40 below threshold/);
    // The scan still yields provenance: the snippet verified and stitched to a bbox.
    expect(absMax?.source.page).toBe(1);
    expect(absMax?.source.bbox).toBeDefined();

    // Invariant sweep: nothing below the gate is ever trusted.
    for (const fact of facts) {
      if (fact.status === "trusted") expect(fact.confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    }
  });

  it("never lets the held fact decide: the rail change is HOLD, not REFUSE or APPROVE", async () => {
    const { facts } = await ingest(doc, fixtureDeps());
    const { verdict } = evaluate(driveFromRail, facts, constraints);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reason).toContain("abs_max_vin_V");
    expect(verdict.citedFact?.key).toBe("abs_max_vin_V");
  });
});
