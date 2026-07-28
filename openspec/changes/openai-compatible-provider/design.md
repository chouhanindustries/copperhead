# Design — openai-compatible-provider

## Context

The OpenAI Node SDK's `OpenAI` constructor accepts a `baseURL` option and uses
it verbatim for every request. Setting it to `https://api.groq.com/openai/v1`
(and providing a Groq key) makes the SDK speak to Groq with no other changes.
The same applies to OpenRouter, Gemini's OpenAI-compat endpoint, Cerebras, and
local Ollama. The entire provider change is threading `baseURL` and a
configurable API-key env-var through the constructor — the rest of this
document is about doing that threading without opening a footgun.

## Decisions

### D1 — Extend `OpenAIProvider`, do not add a new class

The OpenAI SDK already handles any compatible endpoint. A new class would be
pure copy-paste; the only difference is `baseURL`. One class, zero maintenance
overhead. The constructor takes an options object (`{ baseURL?, apiKeyEnv? }`)
plus an injectable `env` parameter, rather than positional `(model, apiKey,
baseURL)` args — clearer call sites, and tests inject fake env vars instead of
mutating `process.env`.

`name` is **not** always `'openai'`: it becomes `'openai-compat'` when
`baseURL` is set (D8 explains why).

### D2 — Config stores the env-var *name*, not the key

`openaiCompatApiKeyEnv: "GROQ_API_KEY"` in config.json; the actual key lives
only in the environment (invariant 6). The provider reads
`env[opts.apiKeyEnv]` at construction time (`env` defaults to `process.env`).

### D3 — Env vars take precedence over config fields, blanks are not values

`COPPERHEAD_BASE_URL` overrides `openaiCompatBaseUrl`; `COPPERHEAD_API_KEY_ENV`
overrides `openaiCompatApiKeyEnv`. Matches the existing
`COPPERHEAD_MODEL > config.model` precedence chain. An env var or config field
set to the empty string (or whitespace) is treated as absent, not as a
configured override — a sourced `.env.example` with a blank
`COPPERHEAD_BASE_URL=` placeholder must fall through to config/default rather
than winning as `""`. `loadConfig` normalizes (`.trim()`) at parse time so
every downstream reader sees the same already-clean value; `resolveCompatSettings`
(D5) is the single place that then applies the env-over-config precedence.

### D4 — `compat:<model-id>` is an explicit, opt-in model route

Earlier drafts of this change routed *any* model id that didn't match
`codex`/`claude*`/`cursor` through the OpenAI-compat-aware path, consulting
`openaiCompatBaseUrl` whenever it happened to be configured. That is a
footgun: a `COPPERHEAD_BASE_URL` (or config field) left over from one
project, or set in a shell profile, would silently redirect an unrelated
`--model gpt-5` or `--model claude` run in a different project to a third
party — the exact class of bug the `.env.example`-blank-value fix in D3
guards against, one layer up.

Instead, `openaiCompatBaseUrl`/`openaiCompatApiKeyEnv` are consulted **only**
when the model string is `compat` or starts with `compat:` — the same
prefix idiom `codex`/`claude-code`/`cursor` already use. Every other model id
(`gpt-5`, a typo, a future model released after this build) goes to the real
OpenAI API exactly as it did before this change. No `COPPERHEAD_PROVIDER`
discriminator env var is needed: the prefix itself is the opt-in signal, and
adding a second toggle for a route that's already explicit would be
redundant.

Bare `compat` (no model id) and `compat:<id>` with no endpoint configured are
both rejected with an actionable error rather than silently falling through
to `OpenAIProvider`'s own default (`gpt-5`) sent to whatever host happens to
be configured, or to the real `api.openai.com` with a non-OpenAI model id.
Unlike `gpt-5`/`claude`, a compatible endpoint serves whatever models its
host chooses, so there is no default that would ever be correct to assume.

### D5 — `resolveCompatSettings()` centralizes the endpoint precedence chain

`makeProvider()`, `diagnose()` (the create-pipeline repair path), and
`doctor`'s credential/privacy checks all need the same
env-over-config-over-default resolution for `openaiCompatBaseUrl`/
`openaiCompatApiKeyEnv`. Rather than each call site re-deriving it (the
earlier draft did, with `||` chains duplicated three times), a single
`resolveCompatSettings(config, env)` in `config.ts` returns a `CompatSettings`
object that every caller threads through. One place to get the precedence
right; one place to fix it if it's ever wrong.

### D6 — Local/loopback endpoints need no credential at all

A local Ollama serves the same API with no auth. Requiring a placeholder
key (`OLLAMA_API_KEY=ollama`, "any non-empty string") is a needless papercut
on the single most useful zero-cost config. `isLocalEndpoint(baseURL)`
classifies `localhost`/`127.0.0.1`/`::1`/`[::1]`/`*.local` as needing no
credential; `OpenAIProvider` skips its missing-key throw for those, and sends
the OpenAI SDK client a placeholder value it will never actually check.
`doctor`'s credential check mirrors this: a local endpoint reports `[ok]`
with no env var required.

### D7 — Doctor command stays LLM-free and network-free

`doctor` checks local configuration only — model resolution, and whether the
resolved credential (if any is required, per D6) is set — and never contacts
the configured endpoint. Actually reaching the endpoint requires the LLM call
itself, so live reachability stays out of scope for a fast, offline
preflight; `copperhead do` with a trivial request is the way to verify
end-to-end connectivity.

Any credential embedded directly in the endpoint URL (a query parameter, e.g.
Gemini's compat endpoint using `?key=...`) is stripped from the doctor
report by displaying only `origin + pathname`, not the full URL.
`redactSecrets`' key-shape patterns (`sk-`, `Bearer`, `npm_`, `gh*_`) don't
cover Gemini's `AIza...` shape or similar future ones; dropping the query
string and userinfo entirely — rather than pattern-matching a key shape —
is what makes the redaction hold regardless of what a given provider's key
looks like.

### D8 — A compat endpoint gets a distinct provider name, for failover safety

`otherProvider()` (agent/loop.ts) fails a rate-limited run over to the other
*keyed* provider by exact name match (`'openai' <-> 'anthropic'`). If
`OpenAIProvider.name` stayed the literal `'openai'` regardless of `baseURL`,
a 429 against a free or local compat endpoint — which routinely rate-limits,
that being the point of a free tier — would silently redirect to a real,
paid Anthropic key sitting in the same environment. A run the user
deliberately pointed at Groq/Ollama/OpenRouter must never fail over to
someone else's paid API with no signal that happened. `name` is
`'openai-compat'` whenever `baseURL` is set, which `otherProvider()`'s exact
match structurally excludes from the keyed-provider failover pair.

### D9 — Ambiguous credentials refuse rather than guess

Unrelated to the compat route itself, but found live while building it: with
no model configured anywhere and **both** `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY` present, `resolveModel` used to silently favor OpenAI.
That is a convenience when there is nothing to guess wrong (exactly one key
present) but a real hazard with two or more — a common setup once a compat
endpoint's key sits alongside the two default provider keys in the same
`.env`. `resolveModel` now throws `ambiguous: N credentials found (...)`
unless exactly one keyed candidate is available or something earlier in the
precedence chain (`--model`, `COPPERHEAD_MODEL`, `config.model`) already
broke the tie. The `compat` route is never an auto-fallback candidate here —
it only ever activates through its explicit prefix (D4).

### D10 — Prompt-privacy classification is shared, not duplicated, and is compat-gated

The privacy signal (does this endpoint's host train on submitted prompts?)
is surfaced in two places — `doctor`'s preflight report, and a one-line
run-start notice in the transcript so a confidential run is warned even if
`doctor` was never run — sharing one `classifyPromptPrivacy(model, compat)`
in `config.ts` rather than two divergent implementations. It:

- Applies only to `compat:<id>` models; `gpt-5`/`claude`/anything else always
  classifies as `'none'`, since `openaiCompatBaseUrl` is never even
  consulted for them (D4).
- Bypasses entirely for **true loopback** (`localhost`/`127.0.0.1`/`::1`) —
  nothing leaves the machine, so there's no third party to have a policy
  about. This is intentionally narrower than `isLocalEndpoint` (D6): a
  `.local`/LAN hostname (e.g. Ollama on a second machine on the same
  network) does *not* get this bypass, because that request genuinely
  leaves the originating machine even though it needs no credential.
- Matches training-risk hosts by hostname (stable) rather than model/tier
  name (rots in months), including subdomains.
- Treats OpenRouter's risk as specific to `:free`-suffixed models, per its
  own documented wording — a fully paid OpenRouter model reports `'unknown'`
  (no policy on record), not `'risk'`; warning on paid usage would be a false
  positive that undermines trust in the other, host-wide warnings (Gemini's
  applies regardless of tier).

`doctor` renders `'risk'` as `[warn]` and `'unknown'` as `[info]`; neither
ever fails the command. The run-start transcript notice only logs on
`'risk'` — `'unknown'` is informational, not actionable, and belongs in the
opt-in `doctor` report, not every run's transcript.

## Configuration surface

`.copperhead/config.json` new fields:
```json
{
  "openaiCompatBaseUrl": "https://api.groq.com/openai/v1",
  "openaiCompatApiKeyEnv": "GROQ_API_KEY",
  "model": "compat:llama-3.3-70b-versatile"
}
```

Env var overrides (take precedence):
```
COPPERHEAD_BASE_URL=https://api.groq.com/openai/v1
COPPERHEAD_API_KEY_ENV=GROQ_API_KEY
COPPERHEAD_MODEL=compat:llama-3.3-70b-versatile
```

## Known free-tier domains (privacy-warning list)

- `generativelanguage.googleapis.com` (Gemini, any tier — detection is not
  tier-aware, since the hostname is the same for free and paid usage)
- `openrouter.ai` (only `:free`-suffixed models; a paid model on the same
  host reports `'unknown'`, not `'risk'`)
- True loopback Ollama is exempt from the privacy check entirely (D10); a
  `.local`/LAN Ollama is not, though it needs no credential (D6)

Cerebras and Groq free tiers are not currently known to train on prompts, but
the warning doc links to each provider's data policy for users to verify.
