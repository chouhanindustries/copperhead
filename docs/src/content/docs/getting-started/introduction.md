---
title: Introduction
description: What copperhead is, how the agent works, and what it deliberately is not.
sidebar:
  order: 1
---

copperhead is an AI agent for circuit boards. It works the way a coding agent works on a codebase, except the repository holds a KiCad project: it reads your design docs, proposes a change as a validated spec, edits the real `.kicad_sch` and `.kicad_pcb` files, verifies its own work with `kicad-cli` ERC and DRC, and writes down why it did what it did.

It is a CLI, it runs against a plain git repository, and it has no hidden state. Everything it knows lives in markdown you can read and review.

## Two ways in

copperhead has exactly two ways in, and they are the same loop underneath.

| | Flow A: from scratch | Flow B: on an existing repo |
| --- | --- | --- |
| Command | `copperhead create --brief brief.md` | `copperhead do "<request>"` |
| Input | A product brief, in markdown | A change request, in natural language |
| Starting point | An empty git repo | A repo that already has a schematic and `docs/` |
| Output | A full design package in `outputs/` | One verified, committed change |

Flow A is Flow B run repeatedly against a growing repo: same loop, same tools, same verification, same guardrails. See [Design from a brief](/workflows/create-from-brief/) and [Edit an existing board](/workflows/edit-existing-board/).

## The two invariants

Everything else in the design follows from these. They are covered in depth in [Guardrails](/concepts/guardrails/).

1. **Spec-gated in.** The agent cannot touch a KiCad file until a validated change proposal exists. The edit tools are structurally absent from its tool list until then, so an ungated edit is not something the model can attempt and fail at: it is not expressible.
2. **Verification-gated out.** No mutation counts as done until ERC (and DRC, if the board changed) passes. The agent repairs from its own error reports, or rolls back to the git snapshot.

## What it is not

- **Not an autorouter.** Routing stays human or delegated. copperhead produces the DRC-clean draft that layout tools optimize from.
- **Not a new editor.** No walled garden. Your KiCad install remains the editor.
- **Not the engineer of record.** A human signs off. The agent never claims a design is fab-ready beyond "ERC and DRC clean".

## Next

- [Quickstart](/getting-started/quickstart/): install, set a key, make your first change
- [The agent loop](/concepts/agent-loop/): what one run actually does
- [CLI reference](/reference/cli/): every command and flag
- [copperhead.sh](https://copperhead.sh): the project site
