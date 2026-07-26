"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ChangeDescriptor,
  ChangeKind,
  ExtractedFact,
  Registry,
  VerificationManifest,
  Verdict,
} from "../core/model";
import type { DigitisedPage } from "../core/pipeline";

interface IngestResponse {
  fileName: string;
  pages: DigitisedPage[];
  facts: ExtractedFact[];
  digitiseModel: string;
  extractorModel: string;
}

interface EvaluateResponse {
  verdict: Verdict;
  manifest: VerificationManifest;
}

const FACT_KEYS = [
  "pin_input_leakage_uA",
  "abs_max_vin_V",
  "quiescent_current_uA",
  "supply_voltage_range_V",
  "recommended_pullup_ohm",
];

export default function Home() {
  const [ingest, setIngest] = useState<IngestResponse | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ page: number; snippet?: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const [label, setLabel] = useState("add 100k pull-up on GPIO12");
  const [kind, setKind] = useState<ChangeKind>("add_component");
  const [factKey, setFactKey] = useState(FACT_KEYS[0]!);
  const [applied, setApplied] = useState("");
  const [appliedUnit, setAppliedUnit] = useState("");

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const loadRegistry = async () => {
    const res = await fetch("/api/registry");
    if (res.ok) setRegistry((await res.json()) as Registry);
  };

  useEffect(() => {
    void loadRegistry();
  }, []);

  const onUpload = async (file: File) => {
    setBusy("Digitising and extracting…");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "ingestion failed");
      setIngest(data as IngestResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const buildDescriptor = (): ChangeDescriptor => {
    const contribution: { factKey: string; value?: number; unit?: string } = { factKey };
    if (applied.trim() !== "" && !Number.isNaN(Number(applied))) {
      contribution.value = Number(applied);
      if (appliedUnit.trim() !== "") contribution.unit = appliedUnit.trim();
    }
    return { kind, label, contributions: [contribution] };
  };

  const onEvaluate = async () => {
    setBusy("Evaluating…");
    setError(null);
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ descriptor: buildDescriptor(), facts: ingest?.facts ?? [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "evaluation failed");
      setResult(data as EvaluateResponse);
      await loadRegistry();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onCorrect = async (key: string) => {
    const numeric = Number(editValue);
    const value = Number.isNaN(numeric) || editValue.trim() === "" ? editValue : numeric;
    setBusy("Saving correction…");
    setError(null);
    try {
      const res = await fetch("/api/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "correction failed");
      setRegistry(data as Registry);
      setEditing(null);
      // Correction propagation (AC-9.1): re-compute the verdict live.
      if (result) await onEvaluate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clickFact = (fact: ExtractedFact) => {
    // Click-to-source (AC-10.1): scroll to the page, highlight the region.
    const target: { page: number; snippet?: string } = { page: fact.source.page };
    if (fact.source.snippet !== undefined) target.snippet = fact.source.snippet;
    setHighlight(target);
    pageRefs.current[fact.source.page]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const downloadManifest = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "verification-manifest.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const regionHighlighted = (page: number, text: string) =>
    highlight?.page === page &&
    highlight.snippet !== undefined &&
    squash(text).includes(squash(highlight.snippet));

  const allFacts: ExtractedFact[] = (() => {
    const merged = [...(registry?.facts ?? [])];
    for (const fact of ingest?.facts ?? []) {
      if (!merged.some((f) => f.key === fact.key)) merged.push(fact);
    }
    return merged;
  })();

  return (
    <main>
      <h1>
        copperhead <span className="accent">intake</span>
      </h1>
      <p className="tagline">
        Datasheet facts with provenance, checked against the board&apos;s rulebook. Every refusal cites
        the datasheet line and the rule line.
      </p>

      <h2>1 · Datasheet</h2>
      <div className="card">
        <div className="row">
          <div>
            <label>Upload datasheet PDF (the 2 relevant pages)</label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
              }}
            />
          </div>
          {ingest && (
            <span className="dim">
              {ingest.fileName}: {ingest.pages.length} pages, {ingest.facts.length} facts (
              {ingest.digitiseModel} + {ingest.extractorModel})
            </span>
          )}
        </div>
        {busy && <p className="dim">{busy}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {(allFacts.length > 0 || registry) && (
        <>
          <h2>2 · Facts ({registry?.part ?? "part"})</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Confidence</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {allFacts.map((fact) => (
                  <tr key={fact.key} className="clickable" onClick={() => clickFact(fact)}>
                    <td>{fact.key}</td>
                    <td>
                      {editing === fact.key ? (
                        <span onClick={(e) => e.stopPropagation()}>
                          <input
                            style={{ width: 90 }}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                          />{" "}
                          <button onClick={() => void onCorrect(fact.key)}>Save</button>
                        </span>
                      ) : (
                        <>
                          {String(fact.value)} {fact.unit ?? ""}
                        </>
                      )}
                    </td>
                    <td>{(fact.confidence * 100).toFixed(0)}%</td>
                    <td>
                      {fact.status === "hold" ? (
                        <span className="badge hold" title={fact.holdReason}>
                          review
                        </span>
                      ) : (
                        <span className="badge trusted">trusted</span>
                      )}
                    </td>
                    <td className="dim">p.{fact.source.page}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {registry?.facts.some((f) => f.key === fact.key) && (
                        <button
                          className="ghost"
                          onClick={() => {
                            setEditing(fact.key);
                            setEditValue(String(fact.value));
                          }}
                        >
                          Correct
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {allFacts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="dim">
                      No facts yet: upload a datasheet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="grid-2">
        <div>
          <h2>3 · Proposed change</h2>
          <div className="card">
            <div className="row">
              <div style={{ flexGrow: 1 }}>
                <label>Change</label>
                <input style={{ width: "100%" }} value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <div>
                <label>Kind</label>
                <select value={kind} onChange={(e) => setKind(e.target.value as ChangeKind)}>
                  <option value="add_component">add component</option>
                  <option value="connect_rail">connect rail</option>
                  <option value="swap_part">swap part</option>
                </select>
              </div>
              <div>
                <label>Deciding fact key</label>
                <select value={factKey} onChange={(e) => setFactKey(e.target.value)}>
                  {FACT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Applied value (optional)</label>
                <input style={{ width: 90 }} value={applied} onChange={(e) => setApplied(e.target.value)} placeholder="e.g. 5" />
              </div>
              <div>
                <label>Unit</label>
                <input style={{ width: 60 }} value={appliedUnit} onChange={(e) => setAppliedUnit(e.target.value)} placeholder="V" />
              </div>
              <button onClick={() => void onEvaluate()} disabled={busy !== null}>
                Evaluate
              </button>
            </div>
            <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>
              Descriptor evaluated: <code>{JSON.stringify(buildDescriptor())}</code>
            </p>
          </div>

          {result && (
            <>
              <h2>4 · Verdict</h2>
              <div className={`card verdict ${result.verdict.decision}`}>
                <div className="decision">{result.verdict.decision}</div>
                <p>{result.verdict.reason}</p>
                {result.verdict.computed && (
                  <p className="computed">{result.verdict.computed.expression}</p>
                )}
                {result.verdict.citedFact && (
                  <div className="citation">
                    <strong>Datasheet line:</strong> {result.verdict.citedFact.rawField} ={" "}
                    {String(result.verdict.citedFact.value)} {result.verdict.citedFact.unit ?? ""}
                    <div className="source">
                      p.{result.verdict.citedFact.source.page}
                      {result.verdict.citedFact.source.snippet
                        ? ` — "${result.verdict.citedFact.source.snippet}"`
                        : ""}
                    </div>
                  </div>
                )}
                {result.verdict.citedConstraint && (
                  <div className="citation">
                    <strong>Rule line:</strong> {result.verdict.citedConstraint.description} (
                    {result.verdict.citedConstraint.kind} {result.verdict.citedConstraint.limit}{" "}
                    {result.verdict.citedConstraint.unit})
                    <div className="source">{result.verdict.citedConstraint.source}</div>
                  </div>
                )}
                {result.verdict.proposedFix && (
                  <p>
                    <strong>Proposed fix:</strong> {result.verdict.proposedFix}
                  </p>
                )}
                <button className="ghost" style={{ marginTop: 12 }} onClick={downloadManifest}>
                  Export verification manifest
                </button>
              </div>
            </>
          )}
        </div>

        <div>
          <h2>Datasheet view</h2>
          {(ingest?.pages ?? []).map((page) => (
            <div
              key={page.page}
              ref={(el) => {
                pageRefs.current[page.page] = el;
              }}
            >
              <div className="page-label">Page {page.page}</div>
              <div className="page-canvas">
                {page.regions.map((region, i) => (
                  <div
                    key={i}
                    className={`region ${regionHighlighted(page.page, region.text) ? "highlight" : ""}`}
                    style={{
                      left: `${region.bbox.x * 100}%`,
                      top: `${region.bbox.y * 100}%`,
                      width: `${region.bbox.width * 100}%`,
                      height: `${Math.max(region.bbox.height * 100, 1.5)}%`,
                    }}
                  >
                    {region.text}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!ingest && <div className="card dim">Upload a datasheet to see its digitised pages.</div>}
        </div>
      </div>
    </main>
  );
}
