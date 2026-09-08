# USB-C create pipeline findings (in progress)

Work toward [#66](https://github.com/copperheadhq/copperhead/issues/66), based on `ef5a129f13b35e67b98216ea2f09aa7739ce6798`, macOS, Node 22.21.1, KiCad 10.0.6 and saved-login Codex. This is an incomplete acceptance report: four stages committed, layout in progress, no complete eight-stage run or recorded replay yet.

## BLOCKER / P1: layout cannot retrieve installed footprint geometry

- **Where:** [layout stage](../../src/commands/create.ts), original capability catalog; live layout attempt on 2026-09-08 at 22:22 UTC.
- **Symptom:** the model authored approximate land patterns from footprint names, producing 76 DRC findings. After rollback, a second attempt explicitly refused because no tool could import the actual geometry. The process exited 1 after four stages. One assigned Würth footprint was also absent from the installed libraries.
- **Suggested:** expose installed-footprint discovery and spec-gated import with schematic net mapping, retaining DRC and rollback.
- **Status:** implemented in [footprints.ts](../../src/kicad/footprints.ts). Native imports of seven components at 0 and 90 degrees have zero library mismatches; the full layout still needs repair. Missing parts require an explicit BOM/intent change, not silent substitution.

## BLOCKER / P1: Codex timeout does not stop its subprocess

- **Where:** [Codex provider](../../src/agent/providers/codex.ts), `close()` and SDK turn lifecycle.
- **Symptom:** the original run logged an abort after 600000 ms, but process inspection showed the original child still alive after 10:08 alongside its retry.
- **Suggested:** pass AbortSignal, settle aborted turns before scratch cleanup, isolate retries and reset the transcript cursor.
- **Status:** fixed. Deterministic tests cover stale responses and retries; a separate real CLI check confirmed child exit, request rejection and directory removal.

## DEFECT / P1: selected part review markers contradict completion

- **Where:** [part-selection prompt and predicate](../../src/commands/create.ts); recurrence of [#133](https://github.com/copperheadhq/copperhead/issues/133).
- **Symptom:** the prompt required `UNVERIFIED`, while the completion predicate rejected concrete MPNs carrying it.
- **Suggested:** distinguish placeholders from concrete flagged selections and preserve already reviewed selections on resume.
- **Status:** fixed with canonical BOM parsing and regression tests. The real part-selection stage committed with concrete flagged MPNs. This gate does not certify datasheets or sourcing.

## DEFECT / P2: synthetic power symbols are compared to installed libraries

- **Where:** [symbol verification](../../src/kicad/symlib.ts); schematic-stage verification at 22:20:53 UTC.
- **Symptom:** engine-owned `copperhead_power:GND` and `PWR_FLAG` were reported as wrong-library. The model changed GND to a signal net to bypass the false positive; the schematic score fell from 82.88 to 81.01.
- **Suggested:** recognize engine-generated semantics separately while preserving ordinary library checks.
- **Status:** fixed. A real generated fixture passes verification; altered private-prefix entries and real library divergences remain checked.

## DEFECT / P2: temp-sweep tests can delete live provider directories

- **Where:** [tmp-sweep tests](../../test/tmp-sweep.test.ts).
- **Symptom:** a test invoked the sweep against the shared OS temp directory with a 60-second cutoff. A concurrent live call later failed with a missing-directory error. The deletion risk is source-proven; deletion of that particular directory was not traced.
- **Suggested:** inject a private sweep root for tests.
- **Status:** fixed and tested. Production defaults are unchanged; subsequent full suites used a separate TMPDIR as well.

## DEFECT / P2: fixture depends on the installed Device:R revision

- **Where:** [fixture library table](../../test/fixtures/open-key/hardware/sym-lib-table); related [#94](https://github.com/copperheadhq/copperhead/pull/94).
- **Symptom:** KiCad 10.0.6 emitted two symbol-library mismatch warnings, causing three fixture-dependent test failures.
- **Suggested:** pin the matching existing test library locally.
- **Status:** fixed without suppressing warnings. The fixture's real ERC reports zero violations.

## INEFFICIENCY / P2: subsystem labels require repeated draft repair

- **Where:** schematic-stage turns 3 through 5.
- **Symptom:** long captions collided; shorter captions exposed overlapping protection/output boxes. The model merged those related groups and regenerated the schematic through normal tools.
- **Suggested:** retain this sequence as evidence when assessing layout-engine improvements.
- **Status:** repaired by the live agent. The schematic stage committed with clean ERC and no error-level legibility findings. No general engine defect is claimed from this observation alone.

## NOTE / P3: environment and implementation validation

- **Where:** KiCad library setup and new import-tool validation.
- **Symptom:** setting only the binary and symbol directory omitted footprint library tables. Native rotation tests also caught incorrect imported pad angles; the live Codex validator rejected the new tool's `minItems` schema keyword.
- **Suggested:** configure isolated library tables, test imported geometry with real KiCad, and test the actual tool schema through the provider validator.
- **Status:** setup corrected; rotation and schema regressions fixed. Nonempty placement validation remains in the handler. Latest full suite: 955 passed, 23 skipped, including the unrecorded E2E harness. No full-board DRC success is claimed.

## DEFECT / P1: project edits can suppress verification findings

- **Where:** [file-edit handler](../../src/capabilities/handlers.ts), `.kicad_pro` edits; layout run `2026-09-08T22-43-51-877Z`, turns 9 through 11.
- **Symptom:** after importing eight real footprints, the model added global DRC severity overrides for unconnected items, hole clearance and silkscreen categories. The reported count fell from 23 to 3 without corresponding geometric repairs. Three footprint mismatches still failed verification; five repair cycles were exhausted, and the stage rolled back. The failed work was preserved in a stash and is not accepted as a solution.
- **Suggested:** reject edits that weaken project verification settings before writing them. Resolve board geometry under the existing rules. Separately reconcile the stage's permission to leave ratsnest with the gate's treatment of unconnected items.
- **Status:** project-policy protection is implemented and tested. It rejects weakening edits before writing the candidate JSON, while preserving existing bootstrap ignores and unrelated edits. It does not claim to cover every KiCad rule representation. No fifth-stage commit or clean-board claim results from this attempt.

## DEFECT / P2: installed footprint conflicts with manufacturing clearance

- **Where:** layout run `2026-09-08T22-43-51-877Z`, four USB-C `hole_clearance` findings; installed GCT USB4105 footprint.
- **Symptom:** the imported footprint faithfully reproduces the [GCT land pattern](https://gct.co/files/drawings/usb4105.pdf), but its outer roundrect pads leave approximately 0.1944 mm to the 0.65 mm NPTH holes. This is below both KiCad's 0.25 mm default and the 0.20 mm NPTH-to-track minimum in the [JLCPCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/) required by the brief. Repositioning the whole footprint cannot fix its internal clearance.
- **Suggested:** revise the part selection to a compatible installed power-only receptacle and regenerate BOM, intent and schematic before repopulating the board. Do not suppress the rule or move individual embedded pads to manufacture a passing report.
- **Status:** the layout prompt now explains this replacement path. An isolated real KiCad check of the installed GCT USB4125 power-only footprint showed no hole-clearance or copper-clearance findings; full design integration, cost and final verification remain outstanding.

## Acceptance evidence outstanding

Stages 5 through 8, final exit 0, final stage summaries, full-board verification and a genuine provider-cache recording replayed in fresh repositories remain required. Unit tests, a DRC-clean empty outline and a published draft PR do not establish those results.
