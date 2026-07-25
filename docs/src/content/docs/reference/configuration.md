---
title: Configuration
description: Config file keys, environment variables, model selection, and the files copperhead writes.
sidebar:
  order: 2
---

## `.copperhead/config.json`

Written by `copperhead init`. Every key is optional; the defaults below apply when a key is absent or the file does not exist.

```json
{
  "schematic": "hardware/board.kicad_sch",
  "board": "hardware/board.kicad_pcb",
  "docs": "docs/",
  "model": null,
  "maxTurns": 40,
  "maxRepairCycles": 5,
  "budgets": {
    "sleep_current_uA": 25
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `schematic` | `null` | Path to the `.kicad_sch`, relative to the repo root. ERC is skipped when null. |
| `board` | `null` | Path to the `.kicad_pcb`. DRC is skipped when null. |
| `docs` | `"docs/"` | The design docs directory: [docs-as-memory](/concepts/docs-as-memory/). |
| `model` | `null` | Default model. Overridden by `--model` and `COPPERHEAD_MODEL`. |
| `maxTurns` | `40` | Turn budget per run. |
| `maxRepairCycles` | `5` | ERC/DRC repair attempts before the run rolls back to the git snapshot. |
| `budgets` | `{}` | Free-form hard constraints, surfaced verbatim into every run's system prompt. |

There is also a `generatedHashes` key, maintained by copperhead. It records content hashes of the generated docs so `init` can tell an untouched file from a hand-edited one. Do not edit it by hand.

### Budgets

Budgets are hard constraints, not hints. A change that would exceed one is refused with an explanation, rather than accepted and discovered later:

```json
{
  "budgets": {
    "sleep_current_uA": 25,
    "bom_cost_usd": 18.50
  }
}
```

The names are yours. copperhead passes them through verbatim and expects the units to be in the key, as in `sleep_current_uA`.

## `.copperhead/constraints.json`

The constraint registry: machine-readable counterparts to the constraints stated in your design docs. Constraints are dual-written, to the doc and to the registry, and the sync-obligations ledger refuses to let a run commit if one was updated without the other.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI credentials. |
| `ANTHROPIC_API_KEY` | Anthropic API credentials. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional. Saved-login token for `--model claude-code` (see below). Minted by `claude setup-token`; lets you run against a Claude subscription with no `ANTHROPIC_API_KEY`. |
| `COPPERHEAD_MODEL` | Default model. Overrides config, overridden by `--model`. |
| `COPPERHEAD_CODEX_PATH` | Optional path to a `codex` executable. Defaults to `codex` on `PATH`; the SDK-bundled launcher is a fallback. |
| `SYNAP_API_KEY` | Optional. Enables cross-run memory. Absent, copperhead behaves exactly as before and makes no Synap calls. |
| `SYNAP_USER_ID` | Optional memory scope. Defaults to your `git config user.email`. |
| `SYNAP_CUSTOMER_ID` | Optional memory scope. Defaults to `copperhead`; only matters on B2B Synap instances. |

A `.env` file in the working directory is read at startup, before any command resolves a model or a provider. A real environment variable always wins over the file. Copy `.env.example` to get started.

Keys are read from the environment only. copperhead never writes one to a config file, and redacts anything matching `sk-[A-Za-z0-9_-]+` when writing transcripts and summaries. Keep `.env` out of git; the shipped `.gitignore` already excludes it.

For `--model codex`, the read-only sandbox blocks native writes but does not restrict native reads to the temporary working directory. Avoiding Codex's own filesystem tools is therefore prompt-enforced. The Codex CLI also stores its own session logs under `~/.codex/sessions/`; those logs can contain prompt and design content and are outside copperhead's `.copperhead/runs/` redaction guarantee.

## Model selection

Resolved in strict precedence order:

1. The `--model` flag
2. `COPPERHEAD_MODEL`
3. `model` in `.copperhead/config.json`
4. `gpt-5` if `OPENAI_API_KEY` is set, otherwise `claude` if `ANTHROPIC_API_KEY` is set

Set any of the first three to `codex` to use the installed Codex CLI and its saved ChatGPT login without a model API key. Plain `codex` uses your Codex default; `codex:<model-id>` selects an explicit Codex model. Run `codex login status` to verify authentication.

If `codex` is not on `PATH`, point `COPPERHEAD_CODEX_PATH` at an executable explicitly. The optional SDK includes one at `node_modules/@openai/codex/bin/codex.js`; for a global installation, `$(npm root -g)/@openai/codex/bin/codex.js` resolves its path.

If none of these produce a model, the command exits with an error telling you the available ways to set one. `check` never needs a model, since it makes no LLM calls at all.

Accepted model values (routing is by prefix, matched top to bottom):

| Value | Provider | Key |
| --- | --- | --- |
| `claude-code` / `claude-code:<id>` | Claude Code, saved login | none (uses `CLAUDE_CODE_OAUTH_TOKEN` / your logged-in CLI) |
| `claude` / `claude-<id>` | Anthropic API | `ANTHROPIC_API_KEY` |
| `gpt-5` / anything else | OpenAI API | `OPENAI_API_KEY` |

`claude-code` is matched before the `claude` prefix, so it is never captured by the Anthropic API route.

### Saved login (Claude Code)

`--model claude-code` drives Claude Code through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and reuses your saved login (the `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`), so a Claude subscription user runs copperhead with **no `ANTHROPIC_API_KEY`**. copperhead uses Claude Code purely as a reasoning backend: the agent loop, its safety gates (snapshot, ERC/DRC verification, rollback, commit gate), and every file edit stay inside copperhead exactly as with the other providers.

One-time setup:

1. The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) ships as an optional dependency of copperhead, so a normal install includes it and no separate step is needed. If you installed with `--omit=optional` and it is missing, copperhead loads it lazily and errors actionably, telling you to add it with `npm i @anthropic-ai/claude-agent-sdk`.
2. Be logged into Claude Code, then run `claude setup-token` and export the result as `CLAUDE_CODE_OAUTH_TOKEN` (use `--model claude-code:<id>` to pick a specific model).

Authentication stays entirely with the CLI: copperhead never reads, copies, or logs the credential. A missing dependency or an unauthenticated install fails with an actionable message and leaves your tree untouched, and a rate-limited `claude-code` run never silently falls back to a billed API provider.

## Files copperhead writes

| Path | Committed? | What it is |
| --- | --- | --- |
| `docs/*.md` | Yes | Design docs. The agent's memory and its output. |
| `.copperhead/config.json` | Yes | Configuration. |
| `.copperhead/constraints.json` | Yes | Constraint registry. |
| `.copperhead/README.md` | Yes | Self-describing docs for the above. |
| `.copperhead/runs/<ts>/` | No | JSONL transcript plus a human-readable `summary.md`. Gitignored. |

## Cross-run memory

With `SYNAP_API_KEY` set, each run recalls relevant context from earlier runs, on this board and others, into the system prompt, then records its outcome, decisions, and refusals back.

In-repo docs and the KiCad files stay the source of truth. Recalled memory is advisory context layered on top, never a substitute for reading `docs/`.

It needs the optional `@maximem/synap-js-sdk` package and a Python 3.11+ runtime on the host, since the JS SDK drives a Python bridge as a subprocess. If either is missing, copperhead logs a line and continues without memory.
