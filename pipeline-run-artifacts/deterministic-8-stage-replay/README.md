# Deterministic eight-stage replay artifacts

This bundle is captured from the cache-only replay in
`test/create-e2e.test.ts`. The production `runCreate` path executes all
eight stages with KiCad verification. A deliberately unavailable fallback
proves all 16 recorded responses came from the warmed on-disk cache.

This bundle is evidence for the deterministic replay. It is not presented as
the separate medium-complexity live run, which remains incomplete and is
documented as such in the pull request.

## Contents

- `project/`: generated brief, KiCad project, design documents, firmware,
  and fabrication outputs.
- `run-artifacts/`: rendered board and schematic SVGs from the outputs stage.
- `run-summaries/`: one `summary.md` from each cache-only replay stage.
- `REPORT.md` and `report.json`: aggregate run reports.
- `git-log.txt`: the seed plus eight independently committed stages.
- `git-status.txt`: final working-tree state.

## Reproduce

```bash
COPPERHEAD_E2E_ARTIFACT_DIR=pipeline-run-artifacts/deterministic-8-stage-replay \
  npm test -- --run test/create-e2e.test.ts
```

The destination must be empty, and `kicad-cli` must be available on
`PATH`.
