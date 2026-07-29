# Generalize the OpenAI provider for OpenAI-compatible endpoints

## Why

Copperhead's OpenAI provider hardcodes its model default (`gpt-5`) and builds its client with no base URL, so the only keyed paths are paid OpenAI or Anthropic credits. Groq, OpenRouter, and Gemini all expose OpenAI-compatible endpoints with recurring free tiers, and Ollama exposes the same interface entirely locally. For an open-source agent, "bring your own key, pay nothing while developing" is a real need the code cannot serve today.

Generalizing the one existing provider covers five-plus backends. Adding four separate provider integrations would be pure maintenance overhead, since all of them speak the same wire protocol.

## What Changes

- `OpenAIProvider` accepts a `baseURL` and reads its key from a configurable environment variable name, instead of always `OPENAI_API_KEY`.
- A local endpoint (Ollama) may run with no key at all; the constructor only requires a key when the endpoint is remote.
- New `compat:<model-id>` route in `makeProvider()`, matching the prefix idiom already used by `codex`, `claude-code`, and `cursor`. Unlike those, bare `compat` (no id) is always rejected: a compatible endpoint has no default model to assume. `makeProvider` gains an optional settings argument; both production call sites already have config in scope.
- New config fields `baseURL` and `apiKeyEnv` in `.copperhead/config.json`, overridable by `COPPERHEAD_BASE_URL` and `COPPERHEAD_API_KEY_ENV`.
- `copperhead doctor` resolves the configured key variable for the compat provider, reports the endpoint, and warns when the endpoint's host is one whose free tier may train on prompts. PCB designs are often proprietary, so that risk is surfaced before a run rather than after. `doctor` stays presence-only: it does not probe the endpoint over the network, so a bad URL or key is what the real run surfaces, not `doctor`.
- A compat entry in the live AC-3.x provider-parity matrix, so a candidate free/local stack can be validated with `npx vitest run test/agent-integration.test.ts` before anyone relies on it.

## Impact

- No new npm dependencies: the existing `openai` client already supports `baseURL`.
- `check` unchanged and still LLM-free and network-free.
- `doctor` remains fully network-free, as documented; it does not add a networked reachability check.
- No structural effect on the invariants: spec-gating and verification-gating are provider-agnostic. Weaker free-tier models are worse at byte-exact anchored edits, which means more repair cycles and more rollbacks. That is the verification gate working as designed, and it is why the documented stack must be validated against the live AC-3.x tests before being recommended.
- Model names live in docs, not code: they rot in months.
