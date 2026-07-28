# Run evidence: `copperhead create` on a medium brief (issue #66)

Brief: `examples/medium/esp32-soil-sensor.md`, unmodified, copied into a fresh test bed as `brief.md`.
Environment: copperhead v0.7.0 (this branch), kicad-cli 10.0.5, node v24.4.1, darwin-arm64, provider `claude-code`.

## Where the pipeline stands

Stages 1 to 4 are committed in the test bed and verified by the pipeline's own gates.
Stage 5 (layout-draft) is the current front: its first blocker (no footprint geometry access) is
fixed on this branch as F-11, and the next attempt stopped at the provider's monthly spend limit
before any turn ran (F-13), which is a schedulable pause rather than a pipeline defect.

| Stage | Status | Evidence |
| --- | --- | --- |
| 1 spec-seed | committed | `5171828`, docs/SPEC.md plus recorded budget constraints |
| 2 architecture | committed (after 1 supervised retry) | `aefffc7`, docs/SUBSYSTEMS.md; the failed attempt's zero-file commit is F-3 |
| 3 part-selection | committed | `3d39da9`, docs/BOM.md, 7 revisit obligations resolved before the finish gate allowed the commit |
| 4 schematic | committed | `a2f697d`, 134 lib_symbols/symbol entries, ERC clean, drift clean, docs/PINOUT.md |
| 5 layout-draft | in progress | refusal grounded in F-11 (now fixed), then a provider spend limit (F-13) |
| 6 to 8 | not reached | outputs, firmware, dev-plan |

## Per-stage cost (from the pipeline's own report)

The run that landed stage 4:

```text
  Stage            Wall  Turns  Out tok  Cache
  --------------  -----  -----  -------  -----
  schematic       3h58m     53   699.2k     0%
  layout-draft    5m23s      4    20.7k     0%
  --------------  -----  -----  -------  -----
  TOTAL           4h03m     57   719.9k     0%
```

Stage 4 needed 53 turns against a 40-turn default, which is finding F-10.

## Artifacts produced in the test bed

`docs/`: BOM.md CHANGELOG.md DECISIONS.md PINOUT.md SPEC.md SUBSYSTEMS.md 
Schematic: `battery-soil-moisture-sensor.kicad_sch`, ERC clean at commit time.

## How to reproduce

```bash
mkdir board && cd board && git init && cp path/to/copperhead/examples/medium/esp32-soil-sensor.md brief.md
git add -A && git commit -m "brief"
export KICAD_SYMBOL_DIR=/path/to/KiCad.app/Contents/SharedSupport/symbols     # see F-4
export KICAD_FOOTPRINT_DIR=/path/to/KiCad.app/Contents/SharedSupport/footprints  # see F-11
copperhead create --brief brief.md --model claude-code
```

Stage turn budgets used for the medium board (F-10), in `.copperhead/config.json`:

```json
{ "stageMaxTurns": { "schematic": 120, "layout-draft": 80 } }
```

Full logs and per-run transcripts are held outside the test bed (F-7 explains why they must be)
and can be attached on request; nothing in them carries credentials, and the pipeline redacts
`sk-` patterns at write time.
