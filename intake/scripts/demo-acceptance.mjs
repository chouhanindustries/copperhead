// End-to-end demo acceptance (task 7.3): GT-1, GT-2, GT-3 back to back,
// against a running dev server, mirroring the exact UI click sequence.
// Each GT must end with a persisted registry entry and a manifest in the
// evaluate response, and the whole arc must finish inside 3 minutes.
//
//   node scripts/demo-acceptance.mjs            # server at localhost:3100
//   BASE_URL=http://localhost:3000 node scripts/demo-acceptance.mjs
//
// The arc uses cached mode (the committed fixture cache), the required demo
// fallback. Real-part extractions hold almost everything by design, so the
// REFUSE verdicts of GT-1 and GT-2 are reached through the correction flow,
// exactly as in the live demo narrative.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const DATASHEETS = join(process.cwd(), "fixtures", "datasheets");
const LIMIT_MS = 3 * 60 * 1000;

let failures = 0;
function check(label, ok, detail = "") {
  const mark = ok ? "ok " : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

async function resetRegistry() {
  const res = await fetch(`${BASE}/api/registry`, { method: "DELETE" });
  if (!res.ok) throw new Error(`registry reset failed: ${res.status}`);
}

async function ingest(fileName) {
  const bytes = readFileSync(join(DATASHEETS, fileName));
  const form = new FormData();
  form.append("file", new File([bytes], fileName, { type: "application/pdf" }));
  form.append("mode", "cached");
  const res = await fetch(`${BASE}/api/ingest`, { method: "POST", body: form });
  const lines = (await res.text()).split("\n").filter((l) => l.trim());
  const last = JSON.parse(lines[lines.length - 1]);
  if (last.t !== "done") throw new Error(`ingest of ${fileName} failed: ${last.error}`);
  return last.facts;
}

async function evaluate(descriptor, facts) {
  const res = await fetch(`${BASE}/api/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ descriptor, facts }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`evaluate failed: ${data.error}`);
  return data;
}

async function correct(key, value) {
  const res = await fetch(`${BASE}/api/registry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`correction failed: ${data.error}`);
  return data;
}

async function registryHasFact(key) {
  const res = await fetch(`${BASE}/api/registry`);
  const registry = await res.json();
  return registry.facts.some((f) => f.key === key);
}

function checkManifest(gt, manifest) {
  check(`${gt} manifest present`, Boolean(manifest?.verdict && manifest?.checksRun));
}

async function runArc(runLabel) {
  console.log(`\n${runLabel}`);
  const t0 = performance.now();

  // GT-1: LM555, keep powered through sleep. The footnote-held supply
  // current first forces HOLD; the user-verified correction (3 mA) turns it
  // into the budget REFUSE with both lines cited.
  console.log("GT-1: LM555 supply current vs the 25 uA sleep budget");
  await resetRegistry();
  const lm555 = await ingest("lm555-electrical.pdf");
  const sleep = {
    kind: "add_component",
    label: "keep the LM555 powered through sleep",
    contributions: [{ factKey: "quiescent_current_uA" }],
  };
  const held = await evaluate(sleep, lm555);
  check("GT-1 pre-correction verdict is HOLD", held.verdict.decision === "HOLD");
  await correct("quiescent_current_uA", 3);
  const gt1 = await evaluate(sleep, lm555);
  check("GT-1 verdict is REFUSE", gt1.verdict.decision === "REFUSE", gt1.verdict.reason);
  check("GT-1 cites the budget constraint", gt1.verdict.citedConstraint?.id === "sleep_current_budget");
  check("GT-1 cites the datasheet fact", gt1.verdict.citedFact?.key === "quiescent_current_uA");
  checkManifest("GT-1", gt1.manifest);
  check("GT-1 registry entry written", await registryHasFact("quiescent_current_uA"));

  // GT-2: ESP32, drive a GPIO from the 5V rail. The held abs-max forces
  // HOLD; correcting it to the datasheet 3.6 V yields the rail REFUSE.
  console.log("GT-2: ESP32 5V rail vs the absolute-maximum input");
  await resetRegistry();
  const esp32 = await ingest("esp32-wroom32-electrical.pdf");
  const rail = {
    kind: "connect_rail",
    label: "drive an ESP32 GPIO from the 5V rail",
    contributions: [{ factKey: "abs_max_vin_V", value: 5, unit: "V" }],
  };
  const railHeld = await evaluate(rail, esp32);
  check("GT-2 pre-correction verdict is HOLD", railHeld.verdict.decision === "HOLD");
  await correct("abs_max_vin_V", 3.6);
  const gt2 = await evaluate(rail, esp32);
  check("GT-2 verdict is REFUSE", gt2.verdict.decision === "REFUSE", gt2.verdict.reason);
  check("GT-2 cites the rail constraint", gt2.verdict.citedConstraint?.id === "rail_voltage_max");
  checkManifest("GT-2", gt2.manifest);
  check("GT-2 registry entry written", await registryHasFact("abs_max_vin_V"));

  // GT-3: SN74LS00, pull-up on a gate input. The footnote-qualified input
  // current is held, so the verdict is HOLD naming the field to re-check.
  console.log("GT-3: SN74LS00 held input current never decides");
  await resetRegistry();
  const ls00 = await ingest("sn74ls00-electrical.pdf");
  const pullUp = {
    kind: "add_component",
    label: "add 100k pull-up on an SN74LS00 input",
    contributions: [{ factKey: "pin_input_leakage_uA" }],
  };
  const gt3 = await evaluate(pullUp, ls00);
  check("GT-3 verdict is HOLD", gt3.verdict.decision === "HOLD", gt3.verdict.reason);
  check("GT-3 names the field to re-check", gt3.verdict.reason.includes("pin_input_leakage_uA"));
  checkManifest("GT-3", gt3.manifest);
  check("GT-3 registry entry written", await registryHasFact("pin_input_leakage_uA"));

  const elapsed = performance.now() - t0;
  check("arc inside 3 minutes", elapsed < LIMIT_MS, `${(elapsed / 1000).toFixed(1)}s`);
  return elapsed;
}

const first = await runArc("Run 1 (cold)");
const second = await runArc("Run 2");
console.log(
  `\n${failures === 0 ? "ACCEPTANCE PASSED" : `ACCEPTANCE FAILED (${failures} checks)`}: run 1 ${(first / 1000).toFixed(1)}s, run 2 ${(second / 1000).toFixed(1)}s (limit 180s each)`,
);
process.exit(failures === 0 ? 0 : 1);
