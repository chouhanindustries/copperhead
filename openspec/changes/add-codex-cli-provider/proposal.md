# Proposal: Add local Codex CLI provider

## Why

Copperhead currently requires a metered OpenAI or Anthropic API key for every agent run, even when the user already has authenticated Codex access through ChatGPT. Users should be able to run the same gated hardware workflow through their existing local Codex CLI login without copying or storing another API credential.

## What Changes

- Add `--model codex`, backed by the official TypeScript Codex SDK and the locally installed `codex` executable.
- Reuse the authentication established by `codex login`; do not read, copy, log, or persist Codex credentials in Copperhead.
- Run Codex as a read-only reasoning backend. All mutations continue to flow through Copperhead's capability-filtered tools, obligations ledger, KiCad verification, snapshot, and commit gates.
- Constrain every Codex response with structured output whose tool-name enum is derived from the tools currently exposed by Copperhead, preserving the structural spec gate.
- Allow an explicit Codex model override as `codex:<model-id>` while plain `codex` follows the user's Codex model configuration/default.
- Document and test the new provider, including a live opt-in provider-parity path.

## Impact

- New optional peer dependency: `@openai/codex-sdk`, loaded only when the Codex provider is selected.
- New optional environment variable: `COPPERHEAD_CODEX_PATH` for installations where `codex` is not on `PATH`.
- No change to `check`/`verify`: it remains LLM-free and network-free.
- Direct OpenAI and Anthropic providers remain supported unchanged.
