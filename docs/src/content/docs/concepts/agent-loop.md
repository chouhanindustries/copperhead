---
title: The agent loop
description: What one copperhead run actually does, from reading the docs to writing down why.
sidebar:
  order: 1
---

It is a loop, and it looks a lot like pair programming, except the codebase is a circuit board.

1. **Start from the docs.** Every decision lives in the design docs, so the agent reads those first and knows the whole design, not just the part in front of it.
2. **Talk through the change.** Describe what you want. The agent proposes the parts and the circuit; you push back until the reasoning holds up.
3. **Edit the real files.** Changes go straight into the KiCad schematic and the design docs, using the same part names and net names everywhere so nothing drifts.
4. **Propagate.** Change one value, like a charge current or a pin assignment, and it carries across every doc and schematic that references it. The boring, easy-to-get-wrong step is the one the agent is best at.
5. **Check the work.** The agent runs ERC and DRC, reads the errors back, and fixes them.
6. **Write down why.** Every real decision gets a one-line reason next to it, so the next change does not quietly undo it.

Steps 3 and 5 are not left to the model's good behavior; they are enforced structurally. See [Guardrails](/concepts/guardrails/).

## How edits are made

KiCad files are edited by anchored exact-match text replacement. copperhead includes an s-expression parser, but it is strictly read-only: it never serializes back out. Nothing round-trips through a data model that might reformat or drop something KiCad cared about, so the diff you review is exactly the change that was intended.

## Run artifacts

Every run writes to `.copperhead/runs/<timestamp>/`: a JSONL transcript of the full agent loop, and a `summary.md` beside it written for a human. Anything matching an API key pattern is redacted at write time.

`.copperhead/runs/` is gitignored by default. The transcripts are for you, not for your history.
