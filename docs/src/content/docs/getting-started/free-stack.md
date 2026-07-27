---
title: Zero-cost contributor stack
description: Run Copperhead's full agent loop during development at zero cost using OpenAI-compatible free-tier providers.
---

Copperhead's OpenAI provider now accepts any OpenAI-compatible endpoint. That
means Groq, Cerebras, OpenRouter, Gemini (OpenAI-compat endpoint), and local
Ollama instances all work with **zero code changes** — just set two environment
variables or two config fields.

## Quick start

```bash
# Groq (free tier, no credit card required)
export COPPERHEAD_BASE_URL=https://api.groq.com/openai/v1
export COPPERHEAD_API_KEY_ENV=GROQ_API_KEY
export GROQ_API_KEY=gsk_...          # from console.groq.com
export COPPERHEAD_MODEL=llama-3.3-70b-versatile

# verify everything is wired correctly before spending any tokens
copperhead doctor

# then run normally
copperhead do "rename net VCC_3V3 to VDD_3V3"
```

```bash
# Cerebras (free tier)
export COPPERHEAD_BASE_URL=https://api.cerebras.ai/v1
export COPPERHEAD_API_KEY_ENV=CEREBRAS_API_KEY
export CEREBRAS_API_KEY=csk_...
export COPPERHEAD_MODEL=llama-3.3-70b

copperhead doctor
```

```bash
# Local Ollama (fully offline, no data leaves your machine)
export COPPERHEAD_BASE_URL=http://localhost:11434/v1
export COPPERHEAD_API_KEY_ENV=OLLAMA_API_KEY   # Ollama accepts any non-empty string
export OLLAMA_API_KEY=ollama
export COPPERHEAD_MODEL=qwen2.5-coder:32b

copperhead doctor
```

## Configuration file alternative

Instead of env vars, you can set the fields once in `.copperhead/config.json`:

```json
{
  "openaiCompatBaseUrl": "https://api.groq.com/openai/v1",
  "openaiCompatApiKeyEnv": "GROQ_API_KEY",
  "model": "llama-3.3-70b-versatile"
}
```

Environment variables always take precedence over config fields:
`COPPERHEAD_BASE_URL` > `openaiCompatBaseUrl`, `COPPERHEAD_API_KEY_ENV` > `openaiCompatApiKeyEnv`.

## copperhead doctor

Run `copperhead doctor` before any agent session to verify:

- **kicad-cli** is on PATH and returns a version string
- The configured **model/provider** resolves correctly
- The **API key** env var is set and non-empty
- Whether the configured tier has a known **privacy risk**

> Doctor is LLM-free and network-free by design. It checks local
> configuration only — it does not probe the remote endpoint. Use
> `copperhead do` with a trivial request to verify end-to-end connectivity.

```
  [ok]  node      v22.15.0 (>= 20)
  [ok]  kicad-cli 8.0.8
  [ok]  git       2.45.0
  [ok]  provider  llama-3.3-70b-versatile -> openai-compat: GROQ_API_KEY set -> https://api.groq.com/openai/v1
  [info] project   no .copperhead/config.json (run `copperhead init` to scaffold)
ready
```

## Privacy warning

Some free tiers may train on your prompts. Copperhead surfaces a warning for
**any Gemini endpoint** (`generativelanguage.googleapis.com` — detection is
not tier-aware, so this fires for paid Gemini usage too) and **OpenRouter
`:free` model suffix**, both in `copperhead doctor` and at run-start in the
transcript.

| Provider | Free tier | Training risk |
|----------|-----------|---------------|
| Groq | Yes | Not known (check [data policy](https://groq.com/privacy-policy)) |
| Cerebras | Yes | Not known (check [data policy](https://cerebras.ai/privacy)) |
| Gemini | Yes | ⚠ Yes on free tier — use paid tier for confidential designs. Doctor warns on this endpoint regardless of tier |
| OpenRouter `:free` | Yes | ⚠ Depends on upstream model — check per-model policy |
| Ollama local | Fully local | ✓ No data leaves your machine |

> PCB designs are often proprietary. When in doubt, use a local Ollama instance
> or a paid API tier with a no-training guarantee.

## Model quality note

Free-tier models are generally weaker at byte-exact anchored edits and
disciplined tool calls than GPT-5 or Claude Opus. The verification gate
(ERC/DRC) will catch failed edits and roll them back — that is the system
working as designed — but it means more repair cycles and longer runs. The
`maxRepairCycles` config value (default 5) gives the model enough attempts to
converge on most simple renames and net edits. For complex multi-file changes,
a stronger paid model may be more cost-effective even on a time basis.

## Live AC-3.x validation

The offline test suite (`npm test`) covers provider routing and config
round-trips without hitting any API. The live AC-3.x integration tests
(`test/agent-integration.test.ts`) require a real provider key. Results for
free-tier providers will be documented here as they are validated against the
full AC-3.x suite.
