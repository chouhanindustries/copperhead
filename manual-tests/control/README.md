# Control boards

Committed reference projects for control-testing the deterministic drafting engine against known inputs. Unlike the fixture-library goldens in `test/fixtures/golden/` (which use tiny in-repo symbol libraries), a control board vendors symbols from the real KiCad standard libraries, so it exercises the engine against production symbol geometry while staying fully hermetic: `sym-lib-cache/` is committed, and every re-draft resolves from it, never from the machine's installed libraries.

## The contract

For each board under this directory:

1. `copperhead draft` on a copy of the project MUST reproduce `reference/<name>.kicad_sch` byte for byte. Any difference is an engine regression (or an intentional change, in which case the reference is regenerated and the diff reviewed).
2. The drafted sheet MUST pass ERC with zero violations and the legibility checker with zero error-severity findings.
3. `reference/<name>.png` is the visual reference. After an intentional engine change, re-render and eyeball the new image against the old one before replacing it; the byte diff says WHAT moved, the render says whether it still reads well.

The byte contract is enforced in CI by `test/draft-control.test.ts`. The visual loop is manual:

```bash
npm run control            # re-draft into manual-tests/runs/control, diff, render
```

The script materializes the board under `manual-tests/runs/control/` (gitignored, per this directory's convention), drafts it, byte-compares against the reference, and renders a PNG next to it for side-by-side comparison.

## Regenerating a reference

After a deliberate engine change:

```bash
npm run control -- --update  # copies the fresh draft and render over reference/
```

Commit the resulting diff and treat the render change as part of review.

## Boards

- `ldo-demo/`: AP1117 LDO with input/output capacitors, power connector, and an LED indicator. Exercises: rail/ground classification from real pin types, PWR_FLAG synthesis on undriven rails only, decoupling-row placement, cross-group net labels, local wire routing, group boxes, content-derived paper.

## Licensing note

`sym-lib-cache/` contains verbatim symbol definitions vendored from the [KiCad symbol libraries](https://gitlab.com/kicad/libraries/kicad-symbols), licensed CC-BY-SA 4.0 with the KiCad libraries exception permitting use in designs. They are included here solely as design/test inputs, unmodified apart from file packaging.
