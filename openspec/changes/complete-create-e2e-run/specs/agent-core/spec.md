# agent-core delta spec

## MODIFIED Requirements

### Requirement: Turn and repair budgets

The loop SHALL enforce `maxTurns` (default 40) and `maxRepairCycles` (default 5 consecutive non-improving ERC/DRC checks), log per-run token usage, and on unrecoverable failure restore the pre-run snapshot, print the transcript path, and exit 1. The first failing check SHALL establish a baseline without spending a repair cycle. A report with fewer violations SHALL reset that check kind's non-improving streak. ERC and DRC SHALL be tracked independently, and a clean report SHALL reset its tracker.

#### Scenario: Improving incremental checks converge (AC-3.5)

- **WHEN** a sequence of failing ERC reports reduces the violation count while a schematic is built incrementally
- **THEN** each lower count resets the non-improving streak and the run is allowed to continue toward a clean report

#### Scenario: Persistent violations still roll back (AC-3.6)

- **WHEN** a verification report fails to reduce its violation count for more than `maxRepairCycles` consecutive checks
- **THEN** the run fails, preserves its work, restores the pre-run snapshot, and reports repair-cycle exhaustion
