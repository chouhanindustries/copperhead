# Copperhead Create Pipeline End-to-End Findings & Recommendations

This report documents the defects, inefficiencies, and blockers identified during the end-to-end audit and execution of the `copperhead create` 8-stage pipeline.

---

## [BLOCKER] Shared Repair Budget Exhaustion on Incremental ERC/DRC Iterations
- **Where:** `src/agent/tools.ts` (`run_erc`, `run_drc`) and `src/agent/loop.ts`
- **Symptom:** The schematic repair prompt operates incrementally (placing and wiring one part at a time). Because the repair loop counted every non-zero ERC/DRC check as a consumed repair cycle regardless of progress, valid multi-turn schematics exhausted their repair budget even while total violation counts were actively decreasing.
- **Suggested:** Track ERC and DRC repair cycles independently, and bound consumption strictly on violation count stagnation. Reset cycle counters whenever total violation counts decrease.
- **Status:** **Fixed** in `src/agent/tools.ts` & `src/agent/loop.ts`.

---

## [DEFECT] Wire Mid-Segment Points and `PWR_FLAG` Net Shadowing
- **Where:** `src/kicad/sexp.ts` (`pinNets`)
- **Symptom:** Schematic net extraction only joined exact wire endpoints, completely ignoring mid-segment labels, pin attachments, and junction nodes. Additionally, `PWR_FLAG` power symbols were allowed to shadow real net names (such as `+3V3` or `GND`), causing incorrect pinout generation.
- **Suggested:** Perform exact integer point-on-segment geometric checks (scaled to KiCad precision) to associate mid-segment connections, and prioritize explicit net labels over generic `PWR_FLAG` values.
- **Status:** **Fixed** in `src/kicad/sexp.ts`.

---

## [INEFFICIENCY] Brittle `layout-draft` Stage Completion Heading Matching
- **Where:** `src/commands/create.ts` (`STAGES[4].isComplete`)
- **Symptom:** Stage 5 (`layout-draft`) checked for the exact literal substring `"## Draft quality"`. Minor formatting variations in generated section headers caused completed draft layouts to fail stage contract validation.
- **Suggested:** Replace literal string search with a heading-aware regex matcher (`docHasHeading`).
- **Status:** **Fixed** in `src/commands/create.ts`.

---

## Priority Recommendations (P0–P3)

- **P0:** Gated CI replay harness — Ensure full 8-stage runs are validated deterministically via local response caches to catch future regressions before release.
- **P1:** Independent repair tracking — Maintain distinct counters for ERC vs DRC iterations.
- **P2:** Robust schematic parsing — Continue expanding s-expression geometric connectivity parsing to support hierarchical sheets.
