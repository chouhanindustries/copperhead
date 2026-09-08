# Design

## Context

The agent can read repository files but cannot retrieve system footprint libraries. A name alone is insufficient to author correct pads.

## Goals / Non-Goals

Import exact installed geometry with deterministic identifiers and schematic net mapping. Do not add an autorouter, weaken DRC, replace existing footprints, or serialize the complete board through the read-only s-expression parser.

## Decisions

Use one gated mutator accepting only references and positions. Resolve all inputs before writing, copy installed footprint definitions and insert into the existing board atomically. Leave missing or ambiguous assignments as explicit errors requiring a corrected BOM and schematic. Mark the PCB touched through the existing ledger helper.

## Risks / Trade-offs

Library revisions affect output; replay must pin tooling and libraries. Pad mapping, rotations, duplicated physical pads and no-connect pins require regression coverage. Existing-board replacement is deliberately refused to preserve user work.
