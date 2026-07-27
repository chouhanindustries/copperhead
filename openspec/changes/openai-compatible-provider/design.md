# Design — openai-compatible-provider

## Context

The OpenAI Node SDK's `OpenAI` constructor accepts a `baseURL` option and uses
it verbatim for every request. Setting it to `https://api.groq.com/openai/v1`
(and providing a Groq key) makes the SDK speak to Groq with no other changes.
The same applies to OpenRouter, Gemini's OpenAI-compat endpoint, Cerebras, and
local Ollama. The entire provider change is threading `baseURL` and a
configurable API-key env-var through the constructor.

## Decisions

### D1 — Extend `OpenAIProvider`, do not add a new class

The OpenAI SDK already handles any compatible endpoint. A new class would be
pure copy-paste; the only difference is `baseURL`. One class, zero maintenance
overhead. `name` stays `'openai'` so failover, metadata, and redaction logic
are untouched.

### D2 — Config stores the env-var *name*, not the key

`openaiCompatApiKeyEnv: "GROQ_API_KEY"` in config.json; the actual key lives
only in the environment (invariant 6). `makeProvider` reads
`process.env[config.openaiCompatApiKeyEnv]` at call time.

### D3 — Env vars take precedence over config fields

`COPPERHEAD_BASE_URL` overrides `openaiCompatBaseUrl`; `COPPERHEAD_API_KEY_ENV`
overrides `openaiCompatApiKeyEnv`. Matches the existing
`COPPERHEAD_MODEL > config.model` precedence chain.

### D4 — No `COPPERHEAD_PROVIDER` discriminator

The routing in `makeProvider()` already catches anything that is not
`codex`/`claude*`/`cursor` and sends it to the OpenAI provider. A baseURL
being set is the only signal needed. Adding an extra env var to toggle a code
path that is already the default would be confusing.

### D5 — `makeProvider()` receives an optional config object

Avoids a second `loadConfig()` call (the caller already loaded it). Passed
through as `Partial<CopperheadConfig> | undefined`; falls back to env-var
reading when absent, preserving full backwards compatibility.

### D6 — Doctor command stays LLM-free and network-free

`doctor` checks local configuration only — model resolution, and whether the
API-key env var it resolves to is set and non-empty — and never contacts the
configured endpoint. Actually reaching the endpoint requires the LLM call
itself, so it stays out of scope for a fast, offline preflight; `copperhead
do` with a trivial request is the way to verify end-to-end connectivity.

`doctor` does not classify endpoints as auth-required vs. no-auth; it always
checks that the configured env var name is set to a non-empty value,
regardless of whether the endpoint itself needs a real key. Local/no-auth
backends like Ollama don't require a real credential, so the setup docs have
the user point the configured env var at any non-empty placeholder (e.g.
`OLLAMA_API_KEY=ollama`) so the check still passes.

### D7 — Privacy warning is emitted by `doctor` and at `run-start`

`doctor` surfaces the warning before any tokens are spent. The loop also emits
a one-line `log()` at run-start if the configured endpoint matches a known
free-tier domain or the model name contains `:free`, so it appears in the
transcript even for non-interactive runs.

## Configuration surface

`.copperhead/config.json` new fields:
```json
{
  "openaiCompatBaseUrl": "https://api.groq.com/openai/v1",
  "openaiCompatApiKeyEnv": "GROQ_API_KEY"
}
```

Env var overrides (take precedence):
```
COPPERHEAD_BASE_URL=https://api.groq.com/openai/v1
COPPERHEAD_API_KEY_ENV=GROQ_API_KEY
```

## Known free-tier domains (privacy-warning list)

- `generativelanguage.googleapis.com` (Gemini free tier)
- `openrouter.ai` (`:free` model suffix)
- Ollama local endpoints are explicitly safe (no data leaves the machine)

Cerebras and Groq free tiers are not currently known to train on prompts, but
the warning doc links to each provider's data policy for users to verify.
