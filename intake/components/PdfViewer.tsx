"use client";

// Renders the uploaded datasheet PDF itself (via pdf.js) with amber
// highlight rectangles drawn from the digitised bounding boxes. Clicking a
// fact elsewhere sets `highlight`; the viewer scrolls to the cited region on
// the matching page and the rectangle containing the fact's snippet flashes.
// (The browser's native PDF plugin cannot host overlays, hence pdf.js.)

import { useEffect, useRef, useState } from "react";
import type { DigitisedPage } from "../core/pipeline";

export interface Highlight {
  page: number;
  snippet?: string;
}

interface RenderedPage {
  pageNumber: number;
  dataUrl: string;
  width: number;
  height: number;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function regionsFor(pages: DigitisedPage[], highlight: Highlight) {
  if (highlight.snippet === undefined) return [];
  const digitised = pages.find((p) => p.page === highlight.page);
  return (digitised?.regions ?? []).filter((r) =>
    squash(r.text).includes(squash(highlight.snippet!)),
  );
}

export default function PdfViewer({
  file,
  pages,
  highlight,
}: {
  file: File | null;
  pages: DigitisedPage[];
  highlight: Highlight | null;
}) {
  const [rendered, setRendered] = useState<RenderedPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setRendered([]);
      return;
    }
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        const data = await file.arrayBuffer();
        const doc = await pdfjs.getDocument({ data }).promise;
        const out: RenderedPage[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
          out.push({
            pageNumber: i,
            dataUrl: canvas.toDataURL("image/png"),
            width: viewport.width,
            height: viewport.height,
          });
          if (cancelled) return;
        }
        if (!cancelled) {
          setRendered(out);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    if (!highlight || rendered.length === 0) return;
    // Scroll only the viewer container (scrollIntoView would drag every
    // scrollable ancestor, shifting the whole page). Aim at the highlighted
    // region itself when we know it, otherwise the top of the page.
    const el = pageRefs.current[highlight.page];
    const container = el?.closest(".viewer-scroll");
    if (!el || !(container instanceof HTMLElement)) return;
    const inner = el.querySelector<HTMLElement>(".pdf-page-inner");
    const containerTop = container.getBoundingClientRect().top;
    let target =
      el.getBoundingClientRect().top - containerTop + container.scrollTop - 12;
    const region = regionsFor(pages, highlight)[0];
    if (region && inner) {
      const innerTop =
        inner.getBoundingClientRect().top - containerTop + container.scrollTop;
      target =
        innerTop + region.bbox.y * inner.clientHeight - container.clientHeight * 0.35;
    }
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [highlight, rendered, pages]);

  if (!file) {
    return (
      <div className="card dim viewer-empty">
        The datasheet renders here after upload. Click any fact to jump to the exact line it came
        from.
      </div>
    );
  }
  if (error) {
    return <div className="card error">PDF rendering failed: {error}</div>;
  }

  return (
    <div className="pdf-viewer">
      {rendered.map((page) => {
        const active =
          highlight?.page === page.pageNumber ? regionsFor(pages, highlight) : [];
        return (
          <div
            key={page.pageNumber}
            className="pdf-page"
            ref={(el) => {
              pageRefs.current[page.pageNumber] = el;
            }}
          >
            <div className="page-label">page {page.pageNumber}</div>
            <div
              className="pdf-page-inner"
              style={{ aspectRatio: `${page.width} / ${page.height}` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={page.dataUrl} alt={`Datasheet page ${page.pageNumber}`} />
              {active.map((region, i) => (
                <div
                  key={`${highlight?.snippet ?? ""}-${i}`}
                  className="pdf-highlight"
                  style={{
                    left: `${region.bbox.x * 100}%`,
                    top: `${region.bbox.y * 100}%`,
                    width: `${region.bbox.width * 100}%`,
                    height: `${region.bbox.height * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
      {rendered.length === 0 && <div className="card dim">Rendering datasheet…</div>}
    </div>
  );
}
