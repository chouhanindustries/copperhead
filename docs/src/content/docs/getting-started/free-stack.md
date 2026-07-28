---
title: Zero-cost contributor stack
description: Run Copperhead's full agent loop during development at zero cost using OpenAI-compatible free-tier providers.
---

Copperhead's OpenAI provider now accepts any OpenAI-compatible endpoint via an
explicit `compat:<model-id>` model route. That means Groq, Cerebras,
OpenRouter, Gemini (OpenAI-compat endpoint), and local Ollama instances all
work with **zero code changes** — just set two environment variables or two
config fields, and prefix the model id with `compat:`.

The route is opt-in on purpose: only `compat:<id>` ever reads
`COPPERHEAD_BASE_URL`/`COPPERHEAD_API_KEY_ENV` (or their config-field
equivalents), so a value configured for one project can never silently
redirect an unrelated `gpt-5`/`claude` run elsewhere.

## Quick start

```bash
# Groq (free tier, no credit card required)
export COPPERHEAD_BASE_URL=https://api.groq.com/openai/v1
export COPPERHEAD_API_KEY_ENV=GROQ_API_KEY
export GROQ_API_KEY=gsk_...          # from console.groq.com
export COPPERHEAD_MODEL=compat:llama-3.3-70b-versatile

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
export COPPERHEAD_MODEL=compat:llama-3.3-70b

copperhead doctor
```

```bash
# Local Ollama (fully offline, no data leaves your machine, no API key needed —
# compat: recognizes any loopback/localhost endpoint and skips the key
# requirement entirely)
export COPPERHEAD_BASE_URL=http://localhost:11434/v1
export COPPERHEAD_MODEL=compat:qwen2.5-coder:32b

copperhead doctor
```

## Configuration file alternative

Instead of env vars, you can set the fields once in `.copperhead/config.json`:

```json
{
  "openaiCompatBaseUrl": "https://api.groq.com/openai/v1",
  "openaiCompatApiKeyEnv": "GROQ_API_KEY",
  "model": "compat:llama-3.3-70b-versatile"
}
```

Environment variables always take precedence over config fields:
`COPPERHEAD_BASE_URL` > `openaiCompatBaseUrl`, `COPPERHEAD_API_KEY_ENV` > `openaiCompatApiKeyEnv`.
A value left blank in either place (an empty string, or whitespace) is treated
as unset rather than as a configured override.

## copperhead doctor

Run `copperhead doctor` before any agent session to verify:

- **kicad-cli** is on PATH and returns a version string
- The configured **model/provider** resolves correctly
- The **API key** env var is set and non-empty (skipped entirely for a local/loopback endpoint)
- Whether the configured endpoint has a known, or unknown, **prompt-privacy policy**

> Doctor is LLM-free and network-free by design. It checks local
> configuration only — it does not probe the remote endpoint. Use
> `copperhead do` with a trivial request to verify end-to-end connectivity.

```
  [ok]   node      v22.15.0 (>= 20)
  [ok]   kicad-cli 8.0.8
  [ok]   git       2.45.0
  [ok]   provider  compat:llama-3.3-70b-versatile -> compat: https://api.groq.com/openai/v1 (GROQ_API_KEY set)
  [info] privacy   api.groq.com: no known training-on-prompts policy on record (copperhead cannot verify this; check the provider's terms)
  [info] project   no .copperhead/config.json (run `copperhead init` to scaffold)
ready
```

With two credentials set and no explicit model anywhere (no `--model`, no
`COPPERHEAD_MODEL`, no `model` in config), `doctor`'s `provider` row reports
`[FAIL] ambiguous: ...` rather than silently picking one — pass `--model` or
set `COPPERHEAD_MODEL` to say which.

## Privacy warning

Some hosts are documented as training on submitted prompts. Copperhead
surfaces a `[warn]` for **any Gemini endpoint** (`generativelanguage.googleapis.com`
— detection is not tier-aware, so this fires for paid Gemini usage too) and
**OpenRouter `:free`-suffixed models specifically** (a paid OpenRouter model
gets `[info]`, not `[warn]`), both in `copperhead doctor` and at run-start in
the transcript. Any other remote host gets a plain `[info]` line naming it —
"no policy on record" is not the same as "safe", just unverified.

A true loopback endpoint (`localhost`, `127.0.0.1`, `::1`) skips the privacy
check entirely — nothing leaves the machine, so there's no third party to
have a policy about. A `.local`/LAN hostname (e.g. a second machine on your
network running Ollama) does **not** get this exemption, since that traffic
does leave the machine it's running on.

| Provider | Free tier | Training risk |
|----------|-----------|---------------|
| Groq | Yes | Not known (check [data policy](https://groq.com/privacy-policy)) |
| Cerebras | Yes | Not known (check [data policy](https://cerebras.ai/privacy)) |
| Gemini | Yes | ⚠ Yes — use paid tier for confidential designs. Doctor warns on this endpoint regardless of tier |
| OpenRouter `:free` | Yes | ⚠ Depends on upstream model — check per-model policy |
| OpenRouter (paid model) | No | Not known — reported as `[info]`, not `[warn]` |
| Ollama, true loopback | Fully local | ✓ No data leaves your machine — no privacy line at all |
| Ollama, LAN (`.local`) | Fully local | Not known — reported as `[info]`, since the request still leaves this machine |

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
