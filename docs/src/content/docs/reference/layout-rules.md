---
title: Layout quality rules
description: Every rule layout_metrics measures, how it is measured, and how the 0-100 score is assembled.
sidebar:
  order: 3
---

`layout_metrics` scores the configured board deterministically: it is a pure function of the parsed `.kicad_pcb` file plus `.copperhead/constraints.json`. It consults neither the model, nor the schematic, nor `kicad-cli`, so it cannot be talked out of a finding. The same rules generate the `## Draft quality` section of `docs/LAYOUT.md` after the layout stage. This page documents each rule as implemented in `src/kicad/layout-metrics.ts` and tested by `test/layout-metrics.test.ts`, `test/layout-mutation.test.ts`, and `test/layout-corpus.test.ts`.

## Hard constraints

Hard rows exist only when a key in `.copperhead/constraints.json` matches one of six suffixes. Matching is by key suffix, so a project's own namespacing (`mech.load_trace_width_mm`, `pwr.trace_width_mm`) reaches the same measurement. Every row reports the key it came from, the expected bound, the measured value, and `pass`, `fail`, or `n/a` with a reason. An empty registry produces an empty table, never invented rows.

| Key suffix | What is measured | How |
| --- | --- | --- |
| `*trace_width_mm` | Narrowest current-carrying track | Minimum segment width on the net the constraint names, or on all power-looking nets when it names none. `n/a` when no such track exists. |
| `*board_outline_mm` | Board outline size | Edge.Cuts extents against a `WxH` in the constraint value (either orientation fits), or against `max` as the largest dimension. `n/a` without an outline or a stated bound. |
| `*keepout` | Separation between two named parts | Centroid-to-centroid distance between exactly two refdes named by the constraint. `n/a` unless both are on the board. |
| `*mounting_hole_clearance_mm` | Copper clearance around mounting holes | Nearest track, via, or pad copper to any mounting-hole pad edge (footprint origin when the hole has no pad). `n/a` without holes or without copper. |
| `*decoupling_distance_mm` | Decoupling pad-to-pin distance | For each capacitor bridging a power rail and ground: distance from its rail pad to the nearest same-net pad on a non-capacitor part. The row reports the worst one. `n/a` when no bypass capacitor qualifies. |
| `*copper_area_mm2` | Copper area on a named net | Tracks, pads, vias, and filled zones on the net the constraint names. Net names come from the net table plus every net resolved on an object, so KiCad 10 boards (net table holding net 0 only) resolve the same way. `n/a` when the named net is not on the board. |

### How n/a rows score

An `n/a` row is never a silent pass, and what it does to the score depends on whether anything is placed:

- **Empty scaffold (zero footprints):** `n/a` rows are excluded from the hard term. Nothing is placed yet, so unanswerable is the honest default, and the placement and routing terms already hold the score down.
- **Populated board (any footprints):** any `n/a` row forfeits the entire 20-point hard term. An unanswerable row can never shrink the denominator and can never score above the same row failing, so deleting the component a constraint polices cannot improve the score. This is what stops deleting the bypass capacitors from outscoring misplacing them.

## Soft scorecard

Measured on every board, with or without constraints:

| Metric | Definition |
| --- | --- |
| Routed nets | Nets with two or more pads whose pads all land in one connected copper component. Connectivity is union-find over 1 µm-quantized points: segments union their endpoints per layer, vias union across their layers, pads snap to track endpoints within `max(padExtent/2, 0.05 mm)`, and a filled zone unions every pad on its net. Deliberately approximate and over-crediting, so it never flags a good board on connectivity it cannot see. |
| Unrouted nets | Named individually, so the report says which nets still need copper. |
| Track length | Total segment length in mm (arcs counted as chords). |
| Courtyard overlaps | Pairs of same-layer footprints whose courtyard extents intersect. |
| Off-board footprints | Footprints whose courtyard extends past the Edge.Cuts outline. |
| Placement density | Courtyard area over board area. |
| Copper area | Tracks, pads, vias, and filled zones, summed per net. |

## The 0-100 score

| Term | Points | Notes |
| --- | ---: | --- |
| Routed nets | 40 | Routed fraction of multi-pad nets. Dominant on purpose: an empty board can never tie a finished one. |
| Hard constraints | 20 | Passing fraction of hard rows, with the n/a rules above. |
| Courtyard clearance | 12 | Zeroed, not awarded, when nothing is placed. |
| On-board placement | 12 | Zeroed when nothing is placed. |
| Placement density | 8 | Fraction of a 35% target density; zeroed when nothing is placed. |
| Routing directness | 8 | Length-weighted mean of minimum-spanning-tree length over actual track length per routed net, skipping pour-connected nets. |

## How the rules are validated

- **Mutation suite** (`test/layout-mutation.test.ts`, runs in CI on committed fixtures): the reference board is degraded four ways (decoupling caps moved 15 mm, power net narrowed to 0.25 mm, placement shuffled, ground zone deleted) and each must strictly lower the score, naming the metric that moved. Deleting the bypass caps must also score no higher than misplacing them.
- **Corpus calibration** (`test/layout-corpus.test.ts`): every board in `/usr/share/kicad/demos` must score without throwing, and the routed `multichannel_mixer` must outscore its unrouted twin. CI installs `kicad-demos` so this tier runs there too; machines without the demos skip it. `npm run layout:corpus` writes the committed baseline distribution.
