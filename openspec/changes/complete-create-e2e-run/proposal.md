# complete-create-e2e-run: Proposal

## Why

The create pipeline explicitly asks the agent to build a schematic one part at a time and run ERC after each part. A live stage-4 run reduced the violation count repeatedly but still rolled back twice because every failing ERC report incremented the global repair counter. The check used to measure convergence was therefore treating convergence as exhaustion.

## What Changes

- Track ERC and DRC violation counts across edits and count only consecutive checks that do not improve.
- Make the drift net parser honor labels and explicit junction points placed in the middle of wire segments, and prevent `PWR_FLAG` from renaming its net.
- Keep the existing bounded rollback after more than `maxRepairCycles` non-improving checks.
- Add focused regression coverage for the observed live sequence, true stagnation, clean resets, and independent ERC/DRC progress.
- Add deterministic create-orchestrator coverage for all eight stages, missing final output, and an empty schematic false green.
- Provide the aggregate `npm run lint` command named by the bounty acceptance criteria.
- Clarify the repair-budget contract in configuration documentation and the canonical specification.

## Capabilities

### Modified Capabilities

- `agent-core`: repair exhaustion is based on consecutive non-improving verification reports rather than every failing report.
- `kicad-tooling`: drift connectivity recognizes labels and junction endpoints on wire interiors, and ERC flags do not rename nets.

## Impact

- `src/agent/tools.ts` owns the progress tracker and applies it to ERC/DRC results.
- `src/agent/loop.ts` initializes the per-run tracker.
- `src/kicad/sexp.ts` resolves legal mid-segment connections and distinguishes an ERC drive flag from a net-naming power symbol.
- `test/create-e2e.test.ts` exercises the stage progression and completion gates without provider cost.
- `CREATE-E2E-FINDINGS.md` records evidence and recommendations from the live run.
- Existing configuration values and rollback behavior remain compatible.
