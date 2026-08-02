# layout-quality delta spec

## ADDED Requirements

### Requirement: Boards are read structurally, across KiCad file generations

A read-only `.kicad_pcb` reader SHALL expose footprints (reference, position,
rotation, layer), pads (number, net, absolute position, extent), courtyard extents,
track segments (endpoints, width, layer, net), vias, zones (net, layer), and the
Edge.Cuts outline extents. Net identity SHALL resolve both the KiCad ≤9 numeric form
(`(net 3 "GND")` on pads, `(net 3)` on segments, resolved through the board's net
table) and the KiCad 10 named form (`(net "GND")`). The board's reported net-name
set SHALL be the union of the net-table names and every net resolved on a pad,
segment, via, or zone, so a KiCad 10 board, whose table holds only net 0, still
reports its nets. The reader SHALL never serialize a board.

#### Scenario: A KiCad 10 board reads its nets

- **WHEN** a board written by KiCad 10 is read
- **THEN** pads and segments report net names taken from their `(net "…")` forms, and the board's net-name set contains those names even though the net table holds only net 0

#### Scenario: A KiCad 8 board reads its nets

- **WHEN** a board written by KiCad 8 is read
- **THEN** numeric net ids on pads and segments are resolved to names through the board's net table

#### Scenario: An empty scaffold reads cleanly

- **WHEN** a board with an outline and no footprints is read
- **THEN** the reader returns zero footprints and the outline extents, without error

### Requirement: Layout metrics are computed from the board file alone

`computeLayoutMetrics(board, constraints)` SHALL return a hard-constraint table and
a soft scorecard computed only from the parsed board and the constraint registry —
never from agent-reported state, the schematic, or `kicad-cli`. The soft scorecard
SHALL include the routed-net fraction, the count and names of unrouted nets, total
track length, track segment and via counts, courtyard overlap count, off-board
footprint count, board area and placement density. A single 0-100 score SHALL be
derived from the soft metrics and the hard table, with the routed-net fraction as
its dominant term, and the placement terms SHALL be zeroed rather than awarded
when the board holds no footprints.

#### Scenario: An empty board does not score like a finished one

- **WHEN** metrics are computed for a board with an outline and zero footprints
- **THEN** the score is below the score of a board with placed and routed parts, and the placement terms contribute zero points

#### Scenario: Placement alone outscores nothing, and routing outscores placement alone

- **WHEN** an empty board, a board with footprints and no copper, and a fully routed board are scored
- **THEN** the three scores are strictly increasing in that order

#### Scenario: Unrouted nets are named

- **WHEN** a board has two multi-pad nets with no copper joining their pads
- **THEN** the scorecard reports a routed-net fraction below 1 and names both nets

### Requirement: Every hard metric traces to a constraint key

Each row of the hard table SHALL name the `.copperhead/constraints.json` key it was
derived from, its expected bound, the measured value, and a status of `pass`,
`fail`, or `n/a`. Keys SHALL be matched by suffix, so a project's own namespacing
reaches the same measurement. A row the board cannot answer SHALL be `n/a` with a
stated reason, never counted as a pass. On a board with no footprints, `n/a` rows
SHALL be excluded from the score's hard term; on a board with footprints, any
`n/a` row SHALL forfeit the hard term entirely, so a row that would fail can never
improve the hard term by becoming `n/a`, deletion of the policed component
included. Soft terms are measured on whatever remains on the board. A board whose
registry has no matching key SHALL produce an empty hard table rather than
invented rows.

#### Scenario: A width constraint produces a traceable row

- **WHEN** the registry holds `mech.load_trace_width_mm` with `min: 1.5` and the board's narrowest track is 0.25 mm
- **THEN** the hard table has one row naming `mech.load_trace_width_mm`, expected `>= 1.5`, actual `0.25`, status `fail`

#### Scenario: No constraints, no hard rows

- **WHEN** the registry is empty, or holds only keys that name no measurable layout property
- **THEN** the hard table is empty and the soft scorecard is still produced

#### Scenario: An unanswerable constraint reads as n/a, not as a pass

- **WHEN** the registry holds a mounting-hole clearance constraint and the empty scaffold has no mounting holes
- **THEN** that row's status is `n/a` with a stated reason, and it does not raise the score

#### Scenario: Deleting the policed component forfeits the hard term

- **WHEN** the decoupling capacitors policed by a decoupling-distance constraint are deleted from a populated board
- **THEN** the decoupling row is `n/a` and the hard term is forfeited rather than springing back to full marks

### Requirement: The agent can measure a layout

A `layout_metrics` tool SHALL expose the scorecard to the agent for the configured
board, returning the hard table, the soft metrics, and the score. It SHALL require
no edit unlock and SHALL report that it does not apply yet when no board is
configured.

#### Scenario: Layout metrics without a board

- **WHEN** `layout_metrics` is called in a repo with no configured board
- **THEN** it returns a message saying the check does not apply yet, rather than an error

### Requirement: Draft quality prose is generated from the scorecard

The `## Draft quality` section of `docs/LAYOUT.md` SHALL be rendered from
`layout_metrics` output, listing every hard row with its constraint key and status
and every soft metric with its value, and SHALL be regenerated in place on later
runs while preserving model-written prose kept below the generated block.

#### Scenario: Regeneration preserves annotations

- **WHEN** `## Draft quality` already exists with generated content plus model prose beneath the marker, and the section is regenerated
- **THEN** the generated block reflects the current board and the prose beneath the marker is unchanged

### Requirement: The scorer is validated by mutation and by corpus

A mutation suite SHALL degrade a committed reference board four ways — decoupling
capacitors moved away from the parts they bypass, the power net narrowed below its
constraint, placement shuffled, and the ground zone deleted — and SHALL require the
score to fall for each. The suite SHALL run in CI on committed fixtures. When
`/usr/share/kicad/demos` is present, a corpus test SHALL additionally require that
every demo board scores without throwing and that the routed `multichannel_mixer`
outscores its unrouted twin; when the directory is absent the corpus test SHALL skip
rather than fail. CI SHALL install the KiCad demos explicitly, so the corpus tier
runs there rather than skipping.

#### Scenario: Each mutation lowers the score

- **WHEN** each of the four degradations is applied to the reference board
- **THEN** the mutated board's score is strictly lower than the original's

#### Scenario: The labeled pair is ranked correctly

- **WHEN** the KiCad demos are installed
- **THEN** `multichannel_mixer.kicad_pcb` scores strictly higher than `multichannel_mixer-unrouted.kicad_pcb`

#### Scenario: A machine without the demos still runs the suite

- **WHEN** `/usr/share/kicad/demos` does not exist
- **THEN** the corpus test skips and the mutation suite still runs and passes
