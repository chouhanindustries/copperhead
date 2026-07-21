---
title: Simple demo
description: Run the create pipeline end to end against the USB-C power breakout brief.
sidebar:
  order: 3
---

The quickest end-to-end demo uses the USB-C power breakout brief. It is intentionally small: one connector, passives, a power LED, and output protection.

## Run it

From the copperhead checkout:

```bash
npm run demo:simple
```

The script creates or resumes a git repo at `demo-runs/usb-c-breakout/`, initializes it if needed, creates a baseline commit for copperhead's rollback snapshots, and runs the create pipeline against:

```text
examples/simple/usb-c-breakout.md
```

You can pass normal `create` flags after `--`:

```bash
npm run demo:simple -- --model claude
npm run demo:simple -- --interactive
```

To place the generated demo somewhere else:

```bash
COPPERHEAD_DEMO_DIR=/tmp/copperhead-usb-c npm run demo:simple
```

## What to expect

The create pipeline is resumable. If the agent stops during a stage, rerun the same command and it continues from the first incomplete stage.

Run transcripts stay in `.copperhead/runs/` inside the demo repo. They are ignored by git, so failed attempts do not make the demo repo dirty.

The demo still uses the real toolchain, so it requires the same things as a normal run: Node.js, `kicad-cli`, git, and either an authenticated local Codex CLI or an OpenAI/Anthropic API key.
