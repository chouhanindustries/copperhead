# acceptance-evidence — Delta Spec

## ADDED Requirements

### Requirement: Nightly live-acceptance workflow
The repository SHALL run the key-gated AC-3.x integration suite on a nightly schedule and on manual dispatch, in a matrix over available providers, with `kicad-cli` installed in the runner. A provider whose key secret is absent SHALL be marked `not_run`, never passed. The workflow SHALL be disableable via a toggle without editing workflow files.

#### Scenario: Nightly matrix executes
- **WHEN** the scheduled workflow fires with both provider keys configured
- **THEN** the AC-3.x suite runs once per provider and each AC's result lands in `status.json`

#### Scenario: Missing key leg is honest
- **WHEN** only one provider key is configured
- **THEN** the other leg reports `not_run` in `status.json` and the badge, not a pass

### Requirement: Evidence promotion with redaction re-check
A passing acceptance run SHALL have its redacted `transcript.jsonl` and `summary.md` committed under `demo-runs/<ac-id>/`, replacing the previous entry for that AC. Before committing, the workflow SHALL grep the candidate files and the full tree for `sk-[A-Za-z0-9_-]{20,}` and SHALL hard-fail the promotion on any match.

#### Scenario: Passing run is published
- **WHEN** AC-3.4 passes in the nightly run
- **THEN** `demo-runs/ac-3.4/` contains that run's transcript and summary, and the README's evidence link resolves to it

#### Scenario: Redaction failure blocks publication
- **WHEN** a candidate transcript contains a string matching the key pattern
- **THEN** no commit is made, the workflow fails, and the failure names the file

### Requirement: Telegraph benchmark runner
`npm run benchmark:telegraph` SHALL execute `copperhead create --brief` for the pinned Open Telegraph brief in a scratch directory outside the repo, then evaluate the trap list in `benchmarks/telegraph/traps.json` (budget refusals, constraint citations, drift catches, gate events) as binary assertions against the run transcript and resulting repo state, exiting non-zero if any trap assertion fails. The committed benchmark result SHALL include the trap outcomes and run summary, not the full transcript.

#### Scenario: Benchmark reproducible by a reader
- **WHEN** a user with an API key runs `npm run benchmark:telegraph` from a clean clone
- **THEN** the pipeline runs from scratch and the script prints per-trap pass/fail with an overall exit code

#### Scenario: Trap regression detected
- **WHEN** a code change causes the 100kΩ pullup trap to be accepted instead of refused
- **THEN** the benchmark exits non-zero naming the `budget_refusal` trap

### Requirement: README claims are generated and checked
The README maturity section SHALL be generated from `status.json` between `<!-- maturity:begin -->`/`<!-- maturity:end -->` markers, and CI SHALL fail when the committed README disagrees with regeneration or when the README's version claim disagrees with `package.json`. Hand edits inside the markers SHALL therefore be build failures.

#### Scenario: Version drift fails CI
- **WHEN** `package.json` is bumped without regenerating the README
- **THEN** the consistency check exits non-zero naming both values

#### Scenario: Maturity section tracks CI reality
- **WHEN** an AC flips from failing to passing in the nightly run
- **THEN** the next regeneration updates the maturity section from `status.json` with no hand editing
