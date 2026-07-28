"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type {
  ChangeDescriptor,
  ChangeKind,
  ExtractedFact,
  Registry,
  VerificationManifest,
  Verdict,
} from "../core/model";
import type { DigitisedPage } from "../core/pipeline";
import PdfViewer, { Highlight } from "../components/PdfViewer";

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

interface Demo {
  part: string;
  file: string;
  blurb: string;
}

const DEMOS: Demo[] = [
  {
    part: "LM555",
    file: "/datasheets/lm555-electrical.pdf",
    blurb: "the timer everyone knows · supply current vs sleep budget",
  },
  {
    part: "SN74LS00",
    file: "/datasheets/sn74ls00-electrical.pdf",
    blurb: "quad NAND · input current vs 25 uA sleep budget",
  },
  {
    part: "ESP32-WROOM-32",
    file: "/datasheets/esp32-wroom32-electrical.pdf",
    blurb: "3.6 V abs-max vs the 5 V rail",
  },
];

interface Preset {
  title: string;
  detail: string;
  descriptor: ChangeDescriptor;
}

const GENERIC_PRESETS: Preset[] = [
  {
    title: "Add a 100k pull-up on a sleeping GPIO",
    detail: "pin leakage vs the 25 uA sleep budget",
    descriptor: {
      kind: "add_component",
      label: "add 100k pull-up on a sleeping GPIO",
      contributions: [{ factKey: "pin_input_leakage_uA" }],
    },
  },
  {
    title: "Drive this pin from the 5V rail",
    detail: "5 V vs the pin's absolute maximum",
    descriptor: {
      kind: "connect_rail",
      label: "drive this pin from the 5V rail",
      contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
    },
  },
  {
    title: "Keep the part powered through sleep",
    detail: "quiescent/supply current vs the sleep budget",
    descriptor: {
      kind: "add_component",
      label: "keep the part powered through sleep",
      contributions: [{ factKey: "quiescent_current_uA" }],
    },
  },
];

/** Change presets tailored to the loaded demo part. */
const PRESETS_BY_PART: Record<string, Preset[]> = {
  LM555: [
    {
      title: "Keep the 555 powered through sleep",
      detail: "its supply current vs the 25 uA sleep budget",
      descriptor: {
        kind: "add_component",
        label: "keep the LM555 powered through sleep",
        contributions: [{ factKey: "quiescent_current_uA" }],
      },
    },
    {
      title: "Add a 100k pull-up on the RESET pin",
      detail: "pin leakage vs the sleep budget",
      descriptor: {
        kind: "add_component",
        label: "add 100k pull-up on the LM555 RESET pin",
        contributions: [{ factKey: "pin_input_leakage_uA" }],
      },
    },
    {
      title: "Drive TRIG from the 5V rail",
      detail: "abs-max rating was not extracted, so the judge must hold",
      descriptor: {
        kind: "connect_rail",
        label: "drive the LM555 TRIG pin from the 5V rail",
        contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
      },
    },
  ],
  SN74LS00: [
    {
      title: "Add a 100k pull-up on a gate input",
      detail: "the LS input current vs the 25 uA sleep budget",
      descriptor: {
        kind: "add_component",
        label: "add 100k pull-up on an SN74LS00 input",
        contributions: [{ factKey: "pin_input_leakage_uA" }],
      },
    },
    {
      title: "Keep the gate powered through sleep",
      detail: "supply current vs the sleep budget",
      descriptor: {
        kind: "add_component",
        label: "keep the SN74LS00 powered through sleep",
        contributions: [{ factKey: "quiescent_current_uA" }],
      },
    },
  ],
  "ESP32-WROOM-32": [
    {
      title: "Drive a GPIO from the 5V rail",
      detail: "5 V vs the module's absolute maximum input",
      descriptor: {
        kind: "connect_rail",
        label: "drive an ESP32 GPIO from the 5V rail",
        contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
      },
    },
    {
      title: "Add a 100k pull-up on a sleeping GPIO",
      detail: "the tiny ESP32 leakage vs the budget: this one can pass",
      descriptor: {
        kind: "add_component",
        label: "add 100k pull-up on a sleeping ESP32 GPIO",
        contributions: [{ factKey: "pin_input_leakage_uA" }],
      },
    },
  ],
};

const FACT_KEYS = [
  "pin_input_leakage_uA",
  "abs_max_vin_V",
  "quiescent_current_uA",
  "supply_voltage_range_V",
  "recommended_pullup_ohm",
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [ingest, setIngest] = useState<IngestResponse | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  const [lastDescriptor, setLastDescriptor] = useState<ChangeDescriptor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [mode, setMode] = useState<"cached" | "live">("cached");
  const [dragOver, setDragOver] = useState(false);
  const [activePart, setActivePart] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  const [customLabel, setCustomLabel] = useState("");
  const [customKind, setCustomKind] = useState<ChangeKind>("add_component");
  const [customKey, setCustomKey] = useState(FACT_KEYS[0]!);
  const [customValue, setCustomValue] = useState("");
  const [customUnit, setCustomUnit] = useState("");

  const loadRegistry = async () => {
    const res = await fetch("/api/registry");
    if (res.ok) setRegistry((await res.json()) as Registry);
  };

  useEffect(() => {
    void loadRegistry();
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy]);

  const appendLog = (message: string) => setLog((prev) => [...prev, message]);

  const onUpload = async (f: File) => {
    setFile(f);
    setIngest(null);
    setResult(null);
    setHighlight(null);
    setLog([]);
    setBusy("ingesting");
    setError(null);
    try {
      // A new datasheet starts clean: drop corrections left over from earlier parts.
      const reset = await fetch("/api/registry", { method: "DELETE" });
      if (reset.ok) setRegistry((await reset.json()) as Registry);
      const form = new FormData();
      form.append("file", f);
      form.append("mode", mode);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { t: "progress"; message: string }
            | ({ t: "done" } & IngestResponse)
            | { t: "error"; error: string };
          if (event.t === "progress") appendLog(event.message);
          else if (event.t === "done") {
            setIngest(event);
            appendLog("ready");
          } else {
            throw new Error(event.error);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      appendLog(`failed: ${message}`);
    } finally {
      setBusy(null);
    }
  };

  const loadDemo = async (demo: Demo) => {
    setBusy("fetching datasheet");
    setError(null);
    setActivePart(demo.part);
    try {
      const res = await fetch(demo.file);
      if (!res.ok) throw new Error(`could not load ${demo.file}`);
      const blob = await res.blob();
      await onUpload(new File([blob], demo.file.split("/").pop()!, { type: "application/pdf" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const evaluateDescriptor = async (descriptor: ChangeDescriptor) => {
    setBusy("evaluating");
    setError(null);
    setLastDescriptor(descriptor);
    appendLog(`evaluating: ${descriptor.label}`);
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ descriptor, facts: ingest?.facts ?? [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "evaluation failed");
      setResult(data as EvaluateResponse);
      appendLog(`verdict: ${(data as EvaluateResponse).verdict.decision}`);
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
    setBusy("saving correction");
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
      appendLog(`corrected ${key} = ${String(value)} (user-verified)`);
      if (lastDescriptor) await evaluateDescriptor(lastDescriptor);
      else setBusy(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const clickFact = (fact: ExtractedFact) => {
    const target: Highlight = { page: fact.source.page };
    if (fact.source.snippet !== undefined) target.snippet = fact.source.snippet;
    setHighlight(target);
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

  // Facts come from the uploaded datasheet's extraction; registry entries only
  // overlay corrections for those same keys (never facts from earlier parts).
  const allFacts: ExtractedFact[] = (() => {
    if (!ingest) return [];
    const corrected = registry?.facts ?? [];
    return ingest.facts
      .map((fact) => corrected.find((f) => f.key === fact.key) ?? fact)
      .sort((a, b) => b.confidence - a.confidence);
  })();

  // Confidence bands: the extraction gate sits at 0.75.
  const confClass = (c: number) => (c >= 0.9 ? "conf-high" : c >= 0.75 ? "conf-mid" : "conf-low");

  const heldCount = allFacts.filter((f) => f.status === "hold").length;
  const presets = (activePart && PRESETS_BY_PART[activePart]) || GENERIC_PRESETS;

  return (
    <div className="shell">
      <header className="topbar">
        <h1>
          <svg className="brand-mark" viewBox="4.625 4.625 22.75 22.75" aria-hidden="true">
            <circle cx="16" cy="16" r="5.25" fill="none" stroke="var(--copper)" strokeWidth="2.25" />
            <path d="M16 5.75v5M16 21.25v5M5.75 16h5M21.25 16h5" stroke="var(--copper)" strokeWidth="2.25" />
          </svg>
          copperhead <span className="accent">intake</span>
        </h1>
        <div className="topbar-right">
          <div className="mode-toggle" title="Cached serves committed fixtures offline; live calls Sarvam + Claude">
            <button className={mode === "cached" ? "on" : ""} onClick={() => setMode("cached")}>
              cached
            </button>
            <button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>
              live
            </button>
          </div>
          <a className="help-link" href="/help" target="_blank">
            help
          </a>
        </div>
      </header>

      <div className="panes">
        {/* Left column: upload dialog, pipeline terminal, change + verdict */}
        <div className="left-col">
          <section className="source-region">
            <div className="upload-dialog">
              <h2>
                <span className="step">1</span> Datasheet
              </h2>
              <label
                className={`dropzone ${dragOver ? "drag" : ""} ${busy !== null ? "disabled" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (busy === null) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (busy !== null) return;
                  const f = e.dataTransfer.files?.[0];
                  if (!f) return;
                  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
                    setError("that file is not a PDF — drop a datasheet PDF");
                    return;
                  }
                  setActivePart(null);
                  void onUpload(f);
                }}
              >
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setActivePart(null);
                      void onUpload(f);
                    }
                  }}
                />
                <svg className="dz-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
                  <path d="M12 15V4m0 0L7 9m5-5l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" />
                  <path d="M4 19.5h16" stroke="currentColor" strokeWidth="1.8" />
                </svg>
                <span className="dz-title">
                  {dragOver ? "Drop it" : "Drag & drop a datasheet PDF"}
                </span>
                <span className="dz-sub dim">or click to browse · 2 key pages is plenty</span>
                {file && <span className="dz-file">{file.name}</span>}
              </label>

              <div className="or-row dim">or pick a demo part</div>
              <div className="demo-grid">
                {DEMOS.map((demo) => (
                  <button
                    key={demo.part}
                    className={`preset ${file?.name === demo.file.split("/").pop() ? "active" : ""}`}
                    disabled={busy !== null}
                    onClick={() => void loadDemo(demo)}
                  >
                    <strong>{demo.part}</strong>
                    <span className="dim">{demo.blurb}</span>
                  </button>
                ))}
              </div>

              {error && <p className="error">{error}</p>}
            </div>
          </section>

          <div className="mid-row">
            <div className="facts-region">
              <h2>
                <span className="step">2</span> Facts{" "}
                {heldCount > 0 && <span className="badge hold h2-note">{heldCount} to review</span>}
              </h2>
              <div className="card no-pad facts-card">
                {allFacts.length === 0 ? (
                  <p className="empty">Extracted facts land here, each with provenance and confidence.</p>
                ) : (
                  <table className="fact-table">
                    <thead>
                      <tr>
                        <th>status</th>
                        <th>parameter</th>
                        <th className="num">value</th>
                        <th className="num">confidence</th>
                        <th className="num">section</th>
                        <th aria-label="action" />
                      </tr>
                    </thead>
                    <tbody>
                      {allFacts.map((fact) => (
                        <Fragment key={fact.key}>
                          <tr
                            className="fact-row"
                            onClick={() => clickFact(fact)}
                            title="click to see the exact line in the datasheet"
                          >
                            <td
                              className={`td-status ${fact.status === "hold" ? "hold" : ""}`}
                              title={fact.status === "hold" ? fact.holdReason : undefined}
                            >
                              {fact.status === "hold" ? "review" : "trusted"}
                            </td>
                            <td className="td-key">{fact.key}</td>
                            <td className="td-value num">
                              {String(fact.value)} {fact.unit ?? ""}
                            </td>
                            <td className={`td-conf num ${confClass(fact.confidence)}`}>
                              {(fact.confidence * 100).toFixed(0)}%
                            </td>
                            <td className="td-cite num">p.{fact.source.page} ↗</td>
                            <td className="td-action num">
                              {fact.status === "hold" &&
                                registry?.facts.some((f) => f.key === fact.key) && (
                                  <button
                                    className="ghost mini"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditing(fact.key);
                                      setEditValue(String(fact.value));
                                    }}
                                  >
                                    Verify
                                  </button>
                                )}
                            </td>
                          </tr>
                          {fact.status === "hold" && editing === fact.key && (
                            <tr className="hold-row">
                              <td />
                              <td colSpan={5}>
                                <div className="hold-line">
                                  <span className="correct-row">
                                    <input
                                      autoFocus
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") void onCorrect(fact.key);
                                      }}
                                    />
                                    <button onClick={() => void onCorrect(fact.key)}>Save</button>
                                    <button className="ghost" onClick={() => setEditing(null)}>
                                      Cancel
                                    </button>
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="stack">
            <div className="work-col">
              <h2>
                <span className="step">3</span> Propose a change
              </h2>
              <div className="preset-grid">
                {presets.map((preset) => (
                  <button
                    key={preset.title}
                    className="preset"
                    disabled={busy !== null}
                    onClick={() => void evaluateDescriptor(preset.descriptor)}
                  >
                    <strong>{preset.title}</strong>
                    <span className="dim">{preset.detail}</span>
                  </button>
                ))}
              </div>

              <details className="custom">
            <summary className="dim">Custom change…</summary>
            <div className="card">
              <label>Describe it</label>
              <input
                style={{ width: "100%" }}
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="e.g. bus-hold resistor on SDA"
              />
              <div className="row" style={{ marginTop: 8 }}>
                <div>
                  <label>Kind</label>
                  <select value={customKind} onChange={(e) => setCustomKind(e.target.value as ChangeKind)}>
                    <option value="add_component">add component</option>
                    <option value="connect_rail">connect rail</option>
                    <option value="swap_part">swap part</option>
                  </select>
                </div>
                <div>
                  <label>Deciding fact</label>
                  <select value={customKey} onChange={(e) => setCustomKey(e.target.value)}>
                    {FACT_KEYS.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Value</label>
                  <input style={{ width: 70 }} value={customValue} onChange={(e) => setCustomValue(e.target.value)} placeholder="5" />
                </div>
                <div>
                  <label>Unit</label>
                  <input style={{ width: 50 }} value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="V" />
                </div>
                <button
                  disabled={busy !== null || customLabel.trim() === ""}
                  onClick={() => {
                    const contribution: { factKey: string; value?: number; unit?: string } = {
                      factKey: customKey,
                    };
                    if (customValue.trim() !== "" && !Number.isNaN(Number(customValue))) {
                      contribution.value = Number(customValue);
                      if (customUnit.trim() !== "") contribution.unit = customUnit.trim();
                    }
                    void evaluateDescriptor({
                      kind: customKind,
                      label: customLabel,
                      contributions: [contribution],
                    });
                  }}
                >
                  Evaluate
                </button>
              </div>
            </div>
          </details>
            </div>

            <div className="work-col">
              <h2>
                <span className="step">4</span> Verdict
              </h2>
          {result ? (
            <div className={`card verdict ${result.verdict.decision}`}>
              <div className="verdict-head">
                <span className="decision">{result.verdict.decision}</span>
                <span className="dim verdict-change">{result.verdict.change}</span>
              </div>
              <p className="verdict-reason">{result.verdict.reason}</p>
              {result.verdict.computed && <p className="computed">{result.verdict.computed.expression}</p>}
              {result.verdict.citedFact && (
                <button
                  className="citation clickable-citation"
                  onClick={() => clickFact(result.verdict.citedFact!)}
                >
                  <strong>Datasheet says:</strong> {result.verdict.citedFact.rawField} ={" "}
                  {String(result.verdict.citedFact.value)} {result.verdict.citedFact.unit ?? ""}
                  <span className="source">
                    page {result.verdict.citedFact.source.page} · click to see the line
                  </span>
                </button>
              )}
              {result.verdict.citedConstraint && (
                <div className="citation">
                  <strong>Board rule:</strong> {result.verdict.citedConstraint.description}
                  <span className="source">
                    {result.verdict.citedConstraint.kind} · limit {result.verdict.citedConstraint.limit}{" "}
                    {result.verdict.citedConstraint.unit} · {result.verdict.citedConstraint.source}
                  </span>
                </div>
              )}
              {result.verdict.proposedFix && (
                <p className="fix">
                  <strong>Try instead:</strong> {result.verdict.proposedFix}
                </p>
              )}
              <button className="ghost" onClick={downloadManifest}>
                Export manifest
              </button>
            </div>
          ) : (
            <div className="card dim verdict-empty">
              APPROVE, REFUSE, or HOLD: always with the datasheet line and the board rule cited. A
              held fact never decides.
            </div>
          )}
            </div>
            </div>
          </div>

          <div className="console" ref={logRef}>
            <div className="console-title">copperhead — pipeline</div>
            {log.length === 0 && !busy && (
              <div>
                <span className="prompt">$</span> idle — pick a part to start the pipeline
              </div>
            )}
            {log.map((line, i) => (
              <div key={i} className={i === log.length - 1 && busy ? "busy-line" : ""}>
                <span className="prompt">$</span> {line}
              </div>
            ))}
          </div>
        </div>

        {/* Right column: the datasheet, full height */}
        <div className="right-col">
          <div className="viewer-scroll">
            <PdfViewer file={file} pages={ingest?.pages ?? []} highlight={highlight} />
          </div>
        </div>
      </div>
    </div>
  );
}
