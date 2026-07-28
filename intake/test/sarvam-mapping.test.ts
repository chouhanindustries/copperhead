import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { estimatePdfPageCount, mapSarvamOutput } from "../adapters/sarvam";

function entry(obj: unknown): Uint8Array {
  return strToU8(JSON.stringify(obj));
}

describe("mapSarvamOutput (tolerant page-JSON mapping)", () => {
  it("maps the confirmed live schema: metadata_page_NNN.json with blocks/coordinates", () => {
    const pages = mapSarvamOutput({
      "metadata_page_001.json": entry({
        page_num: 1,
        image_width: 2550,
        image_height: 3300,
        blocks: [
          {
            block_id: "b0",
            coordinates: { x1: 216, y1: 123, x2: 937, y2: 261 },
            layout_tag: "header",
            confidence: 0.9,
            reading_order: 1,
            text: "SN5400, SN54LS00, SN54S00",
          },
        ],
      }),
      "document.md": strToU8("# not json"),
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text).toContain("SN54LS00");
    const region = pages[0]?.regions[0];
    expect(region?.bbox.x).toBeCloseTo(216 / 2550, 6);
    expect(region?.bbox.height).toBeCloseTo((261 - 123) / 3300, 6);
  });

  it("maps a pages-array document with normalized bboxes", () => {
    const pages = mapSarvamOutput({
      "output.json": entry({
        pages: [
          {
            page_number: 1,
            blocks: [
              { text: "Input leakage current 0.033 mA", bbox: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 } },
            ],
          },
        ],
      }),
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]?.regions[0]?.bbox).toMatchObject({ x: 0.1, y: 0.2 });
    expect(pages[0]?.text).toContain("Input leakage");
  });

  it("maps per-page files with pixel coordinates scaled by page dims", () => {
    const pages = mapSarvamOutput({
      "page_2.json": entry({
        page: 2,
        width: 1000,
        height: 2000,
        elements: [{ content: "Abs max 3.6 V", bounding_box: [100, 200, 500, 300] }],
      }),
    });
    expect(pages[0]?.page).toBe(2);
    expect(pages[0]?.regions[0]?.bbox).toMatchObject({ x: 0.1, y: 0.1, width: 0.4, height: 0.05 });
  });

  it("keeps text but drops regions when coordinates are unusable", () => {
    const pages = mapSarvamOutput({
      "page_1.json": entry({
        page: 1,
        text: "Some page text",
        blocks: [{ text: "orphan", bbox: [900, 100, 950, 120] }],
      }),
    });
    expect(pages[0]?.text).toBe("Some page text");
    expect(pages[0]?.regions).toHaveLength(0);
  });

  it("survives malformed entries, non-JSON files, and the empty case", () => {
    expect(mapSarvamOutput({})).toEqual([]);
    const pages = mapSarvamOutput({
      "broken.json": strToU8("{ nope"),
      "image.png": strToU8("binary"),
      "page_1.json": entry({ page: 1, text: "ok", blocks: [] }),
    });
    expect(pages).toHaveLength(1);
  });
});

describe("page budgeting", () => {
  it("estimates page count from PDF page objects", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Page >>\nendobj\n2 0 obj << /Type /Page >>\nendobj\n3 0 obj << /Type /Pages /Count 2 >>",
    );
    expect(estimatePdfPageCount(pdf)).toBe(2);
  });

  it("returns 0 for non-PDF bytes (never blocks on estimate failure)", () => {
    expect(estimatePdfPageCount(Buffer.from("not a pdf"))).toBe(0);
  });
});
