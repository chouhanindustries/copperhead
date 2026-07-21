# create-pipeline — Delta Spec

## MODIFIED Requirements

### Requirement: Resumability from repo state
Pipeline state SHALL live in the repo: stage completion records with input/output content hashes in `.copperhead/create-state.json` (committed with each stage's own commit), with the stage table's existing completion probes as the fallback for stages that have no record. A killed `create` re-run SHALL continue from the first stage that is not fresh — skipping fresh and assumed-complete stages — and a default `create` run SHALL also re-run stages classified stale (a recorded input hash no longer matches), so drift introduced between runs is reconciled automatically rather than skipped past.

#### Scenario: Resume after kill
- **WHEN** `create` is killed after the BOM stage and re-run
- **THEN** it skips spec/architecture/BOM and resumes at the schematic stage

#### Scenario: Default run heals staleness
- **WHEN** BOM.md was edited after the schematic stage completed and `create` is re-run with no flags
- **THEN** the schematic stage re-runs with a reconciliation prompt naming `bom` as the changed input, and fresh stages are skipped

## ADDED Requirements

### Requirement: Targeted stage re-runs
`create --stage <name>` SHALL run exactly the named stage against the existing artifacts, then propagate: re-hash its produced artifacts and reconcile stale consumers per the pipeline-invalidation capability. `create --from <name>` SHALL force-re-run the named stage and its graph descendants (stages reachable via produces→consumes edges) in dependency order, leaving non-descendant stages untouched. A re-run of a previously completed stage SHALL carry a revise-not-recreate preamble in its stage prompt, and every normal gate applies unchanged.

#### Scenario: Single-stage revision propagates only real changes
- **WHEN** `create --stage part-selection` revises BOM.md (a value changes) but the schematic re-run then commits no footprint change
- **THEN** `schematic` re-runs (consumes `bom`), `outputs` re-runs only if an artifact it consumes changed, and `firmware` never runs

#### Scenario: --from re-runs descendants only
- **WHEN** `create --from layout-draft` runs
- **THEN** `layout-draft`, `outputs`, and `devplan` re-run in dependency order and `firmware` (not a descendant of `layout-draft`) is skipped

#### Scenario: Re-run revises instead of recreating
- **WHEN** `create --stage part-selection` runs on a repo with an existing BOM.md
- **THEN** the stage edits the existing BOM.md via anchored edits (its stage prompt says to revise), and any attempt to overwrite the file wholesale is structurally refused by `write_file`
