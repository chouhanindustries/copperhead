# Add configurable OpenAI-compatible provider

## Why

Copperhead's `OpenAIProvider` hardcodes the OpenAI base URL and requires
`OPENAI_API_KEY`. That locks every contributor into paid OpenAI or Anthropic
credits even though Groq, OpenRouter, Gemini, Cerebras, and local Ollama all
expose an OpenAI-compatible REST API with recurring free or self-hosted tiers.
For an open-source agent working on real hardware repositories, "bring your own
key, pay nothing during development" is a genuine need the current code cannot
serve.

## What Changes

1. **Configurable OpenAI-compatible provider, opt-in via `--model compat:<id>`.**
   `OpenAIProvider` gains a `baseURL` option and reads its API key from a
   configurable env-var name (defaulting to `OPENAI_API_KEY`). Two new optional
   fields in `.copperhead/config.json` (`openaiCompatBaseUrl`,
   `openaiCompatApiKeyEnv`) and two corresponding env-var overrides
   (`COPPERHEAD_BASE_URL`, `COPPERHEAD_API_KEY_ENV`) let users point at any
   OpenAI-compatible endpoint without a code change. Only the explicit
   `compat`/`compat:<id>` model prefix ever consults these — a configured
   endpoint never redirects a plain `gpt-5`/`claude` run. A local/loopback
   endpoint (Ollama) needs no credential at all.

2. **`copperhead doctor` command.** A deterministic, LLM-free, network-free
   diagnostic that checks KiCad CLI availability, resolves the configured
   provider and its credential (skipped for a local/loopback compat endpoint),
   and emits a non-blocking privacy signal — `[warn]` for a documented
   training-risk host, `[info]` naming the host when no policy is on record —
   for a `compat:<id>` endpoint. It does not probe the endpoint over the
   network: reaching it at all requires the LLM call itself, which is out of
   scope for a fast offline preflight.

3. **Zero-cost contributor docs page.** `docs/src/content/docs/getting-started/free-stack.md`
   describes a currently-validated free contributor setup with the privacy
   caveat and a pointer to `copperhead doctor`.

4. **Ambiguous-credential refusal.** Unrelated to the compat route itself but
   found while validating it live: with no model configured anywhere and both
   `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` present, model resolution now
   refuses with an actionable `ambiguous:` error instead of silently favoring
   one provider.

## Impact

- No new npm dependencies.
- `check` and `verify` are unchanged (LLM-free, network-free).
- Spec-gating and verification-gating are provider-agnostic: no effect on
  invariants 1–2.
- Failover (`otherProvider`) gains a safety property rather than staying
  unchanged: a compat-endpoint provider's `name` is `'openai-compat'`, not
  `'openai'`, so a rate limit against a free/local endpoint can never
  silently fail over to a real, paid Anthropic key in the same environment.
- API keys never touch config.json: the new field stores the env-var *name*,
  not the key value (invariant 6). Any credential embedded in the endpoint
  URL itself (e.g. Gemini's `?key=...`) is stripped from doctor's report by
  displaying only origin + path, not pattern-matching a key shape.
