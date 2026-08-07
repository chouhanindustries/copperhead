# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Stage-4 entry pin dossier

Before each attempt of the schematic stage runs, the pipeline SHALL resolve every BOM part against the installed symbol libraries and inject the result into the stage prompt as a machine-verified dossier, so the agent starts with the pin facts it would otherwise spend turns reconstructing. Resolution SHALL query the part's MPN first and fall back to its Value, and SHALL be recomputed per attempt, since a rolled-back retry can run against a different BOM than its predecessor.

For each covered part the dossier SHALL name the part's refdes and query, the top-ranked installed lib_id, and that symbol's real pins (number, name, electrical type), following `extends` links. A symbol defining more than one unit SHALL be flagged as one the drafting engine refuses. Alternative candidate lib_ids SHALL be listed so a wrong top match is recoverable without a search turn. A part no installed symbol matches SHALL be named as such, with the instruction to substitute, rather than omitted.

Pure-passive refdes classes (R, C, L) are drawable from their canonical `Device:*` symbols and SHALL be omitted by design.

The dossier SHALL be bounded in size, and parts beyond the bound SHALL be named as not included — with the instruction to fetch them via `symbol_pins` — never silently dropped, so absence from the dossier is never readable as absence from the libraries. Dossier construction SHALL NOT block the stage: on any error, or when no BOM exists, the stage runs with no dossier block, exactly as before this change.

A NO-INSTALLED-SYMBOL line is an absence claim, and the dossier SHALL make one only after at least one library was actually readable: when no `.kicad_sym` resolves in any search directory, the machine has verified nothing, and the dossier SHALL be omitted entirely rather than assert absence for every part. "Could not check" and "checked and absent" are different facts, and a block labeled machine-verified must never render the first as the second.

#### Scenario: Covered part needs no discovery turns

- **WHEN** the BOM names a part whose symbol is installed
- **THEN** the stage-4 prompt already contains its lib_id and full pin table, and the agent can author `REF.PIN` endpoints without reading any `.kicad_sym`

#### Scenario: Genuinely absent part is surfaced at entry

- **WHEN** a BOM part matches no installed symbol under its MPN or Value
- **THEN** the dossier says so on the part's own line, so substitution starts on turn 1 instead of after a failed draft

#### Scenario: Size overflow is disclosed

- **WHEN** the rendered dossier would exceed its size bound
- **THEN** the parts left out are named as not included, with `symbol_pins` given as the way to fetch each

#### Scenario: Dossier failure does not block the stage

- **WHEN** the BOM is missing or dossier construction throws
- **THEN** the stage prompt is exactly the pre-change prompt and the stage proceeds

#### Scenario: An unreadable library yields silence, not false absence

- **WHEN** no symbol library is readable in any search directory
- **THEN** no dossier is injected at all — the block never claims NO INSTALLED SYMBOL for parts the machine could not actually check

## MODIFIED Requirements

### Requirement: Stage 3 availability probing

The part-selection prompt SHALL require the agent to probe availability with `search_symbols` for every active part (IC, module, connector) before the BOM commits, and to substitute any part with no installed symbol, since stage 4 draws only from installed symbols and an unresolvable BOM row makes the run unwinnable.

The prompt SHALL additionally require confirming drawability, not just existence: `symbol_pins` on the chosen symbol, substituting when it reports more than one unit, since the drafting engine refuses multi-unit symbols and stage 4 discovers that refusal only after the pin map is doc-truth. The availability and drawability requirements stay at prompt strength; the stage completion gate is unchanged (fuzzy MPN-to-symbol matching in a gate would refuse valid BOMs).

#### Scenario: Multi-unit trap is caught at part selection

- **WHEN** the agent's candidate part resolves only to a multi-unit symbol (a dual-gate pack)
- **THEN** the stage-3 contract directs it to the single-unit variant before the BOM row commits, instead of stage 4 discovering the refusal after the netlist is designed
