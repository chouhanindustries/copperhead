# Design changelog

Append-only, newest first. One entry per committed copperhead run.

## 2026-07-26 — create pipeline stage: devplan

- Change: replay-devplan
- Files: docs/DEVPLAN.md
- Verification: ERC not required

## 2026-07-26 — create pipeline stage: firmware

- Change: replay-firmware
- Files: firmware/pins.h
- Verification: ERC not required

## 2026-07-26 — create pipeline stage: outputs

- Change: replay-outputs
- Files: outputs/
- Verification: ERC not required

## 2026-07-26 — create pipeline stage: layout-draft

- Change: replay-layout-draft
- Files: replay-board.kicad_pcb, docs/LAYOUT.md
- Verification: ERC clean, DRC clean

## 2026-07-26 — create pipeline stage: schematic

- Change: replay-schematic
- Files: replay-board.kicad_sch, docs/PINOUT.md
- Verification: ERC clean

## 2026-07-26 — create pipeline stage: part-selection

- Change: replay-part-selection
- Files: docs/BOM.md
- Verification: ERC not required

## 2026-07-26 — create pipeline stage: architecture

- Change: replay-architecture
- Files: docs/SUBSYSTEMS.md
- Verification: ERC not required

## 2026-07-26 — create pipeline stage: spec-seed

- Change: replay-spec-seed
- Files: docs/SPEC.md
- Verification: ERC not required
