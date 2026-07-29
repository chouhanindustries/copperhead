# Design — OpenAI-compatible provider

## D1. Selection is a model prefix, not a separate provider switch

**Decision.** Route on `compat:<model-id>`, resolved through the existing `resolveModel()` precedence chain. `baseURL` and `apiKeyEnv` are *settings* carried in config/env, not selectors. Bare `compat` is always rejected, unlike `codex`/`claude-code`/`cursor` where the bare form selects a default: a compatible endpoint has no default model, so there is nothing safe to assume.

**Rejected alternative: `COPPERHEAD_PROVIDER=openai-compatible`.** The issue's example proposes an environment switch. It was rejected because it introduces a second, parallel model-selection mechanism alongside `resolveModel()`, whose precedence chain (flag > `COPPERHEAD_MODEL` > config > available key) is currently the single answer to "which model runs". Two selectors have to define, document, and test their interaction: if `--model claude` and `COPPERHEAD_PROVIDER=openai-compatible` are both set, one has to win, and no reading of that is obvious. A prefix has none of that ambiguity and matches the four routes that already exist (`codex:`, `claude-code:`, `cursor:`, `claude`).

`COPPERHEAD_BASE_URL` and `COPPERHEAD_API_KEY_ENV` from the issue's example are still honoured, because they carry settings rather than choosing a provider.

## D2. An explicit opt-in is required; a stray base URL never redirects a run

**Decision.** Only the `compat` route consults `baseURL`. A plain `--model gpt-5` keeps going to `api.openai.com` even when `COPPERHEAD_BASE_URL` is set in the environment.

Silently redirecting a keyed OpenAI run to a third-party endpoint because a variable was left exported is a confidentiality problem, not a convenience. The user asks for the compat path by name.

## D3. `makeProvider` takes an optional settings argument

**Decision.** `makeProvider(model, sessionResume?, compat?)`.

`makeProvider` has two production call sites (`loop.ts`, `create.ts`), and both already have the loaded config in scope. Every existing test calls it with a single argument, so an optional trailing parameter is source-compatible: no test churn, no signature break for callers that do not use the compat route.

## D4. A local endpoint may be keyless; a remote one may not

**Decision.** The constructor requires a key only when the resolved endpoint is remote. Ollama's OpenAI-compatible server needs no credential, and it is the one backend that is both free and fully local, so requiring a dummy key would be a papercut on the most useful configuration. A remote endpoint with no key still fails fast, with a message naming the variable it expected.

## D5. The training-risk warning keys on hostname, at `warn` severity

**Decision.** A small host-to-policy map (for example Gemini's free tier, OpenRouter `:free` model suffixes) drives a `warn`-level `doctor` line. Never `fail`.

Hostnames are stable; model names and tier rules are not, which is why the tier table lives in docs. `warn` rather than `fail` because a policy caution must not make `doctor` exit non-zero: a contributor deliberately using a free tier on a non-proprietary board is not misconfigured. Unknown hosts say so rather than implying a guarantee copperhead cannot make.
