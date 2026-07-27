---
name: copperhead
description: Design and edit KiCad projects through the copperhead MCP server instead of editing .kicad_sch/.kicad_pcb files directly. Use whenever a task touches a KiCad schematic or board, its design docs (BOM/PINOUT/SPEC), or asks to verify, change, or reconcile a hardware design in a repo where the copperhead MCP server is configured.
metadata:
  author: copperhead
  version: "1.0"
---

# copperhead

This repository is a real KiCad project managed by copperhead. copperhead is a gated design agent: every change is spec-gated (a proposal must validate before any edit), verification-gated (ERC, and DRC when the board changes, must pass), and wrapped in a git snapshot that rolls back on failure.

## The one rule

Do NOT edit `.kicad_sch`, `.kicad_pcb`, or the generated design docs directly with your own file tools. A raw edit bypasses spec-gating, ERC/DRC verification, and rollback, which is exactly what copperhead exists to prevent. Route every design change through the copperhead MCP tools.

## Which tool to call

- **`copperhead_do`**: make a design change. Pass a clear natural-language `request` (for example, "move the ESP32 EN pull-up from GPIO2 to GPIO4 and update PINOUT.md"). The tool runs the whole gated loop and returns a result with `status`:
  - `committed`: the change passed verification and was committed. Report the `commit`, `filesTouched`, and `verification`.
  - `rolled_back`: verification could not be satisfied, so the working tree was restored. This is a normal result, not an error. Do NOT try to make the change by hand instead. Read the `transcript`, refine the request, and call `copperhead_do` again.
  - `refused`: copperhead declined because the request violated a documented budget or constraint. Relay the `summary`; do not work around it.
  - Use `dry_run: true` to see a proposed change without committing.
- **`copperhead_check`**: verify the current repo (ERC, DRC, doc drift, constraints). Read-only, no key needed. Run it before and after a session, and whenever you want to know if the design is clean.
- **`copperhead_sync`**: report inconsistencies between the docs and the as-built design. Add `resolve: true` to have copperhead fix drift; requirement violations are flagged for a human and never auto-resolved.
- **`copperhead_init`**: scaffold the docs-as-memory layer for a KiCad repo that copperhead has not been pointed at yet.

## Relaying results honestly

The tool result is the source of truth. Report the status copperhead returns, including rollbacks and refusals, and cite the transcript path. Never claim a design is verified beyond the `verification` field copperhead reports, and never present a change as applied when the status was `rolled_back` or `refused`.

## Keys

`copperhead_do` and `copperhead_sync` with `resolve: true` need an LLM API key in the environment where the server runs; if none is present they return a typed error naming the missing variable. `copperhead_check` and `copperhead_init` always work without a key.
