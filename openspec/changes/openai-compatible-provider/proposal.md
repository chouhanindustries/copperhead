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

1. **Configurable OpenAI-compatible provider.** `OpenAIProvider` gains a
   `baseURL` parameter and reads its API key from a configurable env-var name
   (defaulting to `OPENAI_API_KEY`). Two new optional fields in
   `.copperhead/config.json` (`openaiCompatBaseUrl`, `openaiCompatApiKeyEnv`)
   and two corresponding env-var overrides (`COPPERHEAD_BASE_URL`,
   `COPPERHEAD_API_KEY_ENV`) let users point the existing provider at any
   OpenAI-compatible endpoint without a code change.

2. **`copperhead doctor` command.** A deterministic, LLM-free diagnostic that
   checks KiCad CLI availability, resolves the configured provider and key,
   probes endpoint reachability, and emits a privacy warning when the
   configured provider or model is a known free tier that may train on prompts.

3. **Zero-cost contributor docs page.** `docs/src/content/docs/getting-started/free-stack.md`
   describes a currently-validated free contributor setup with the privacy
   caveat and a pointer to `copperhead doctor`.

## Impact

- No new npm dependencies.
- `check` and `verify` are unchanged (LLM-free, network-free).
- Spec-gating and verification-gating are provider-agnostic: no effect on
  invariants 1–2.
- Failover (`otherProvider`) is unchanged: provider `name` stays `'openai'`.
- API keys never touch config.json: the new field stores the env-var *name*,
  not the key value (invariant 6).
