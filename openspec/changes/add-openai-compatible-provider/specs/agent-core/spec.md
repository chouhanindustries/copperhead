# agent-core — Delta Spec

## MODIFIED Requirements

### Requirement: Provider list includes a compatible-endpoint mode
The provider list (§4.4) SHALL include the OpenAI provider's compatible-endpoint mode: `compat:<model-id>`, a keyed HTTP provider with a configurable `baseURL` and credential variable name, covering Groq, OpenRouter, Gemini's OpenAI-compatible endpoint, and a local Ollama server. `makeProvider()` SHALL accept optional compatible-endpoint settings alongside the model string; the parameter is optional, so callers that do not use the compat route are unaffected.

#### Scenario: the compat route reaches the configured endpoint
- **GIVEN** compatible-endpoint settings resolved from config or environment
- **WHEN** `makeProvider()` is called with `compat:<model-id>`
- **THEN** it returns the OpenAI provider bound to that endpoint and model id

#### Scenario: existing routes are unaffected
- **WHEN** `makeProvider()` is called with `gpt-5`, `claude`, `codex`, `claude-code`, or `cursor`
- **THEN** routing is exactly as before, and no compatible-endpoint setting is consulted

### Requirement: A rate-limited compat run never fails over to a paid key
The compatible-endpoint provider SHALL be structurally distinguishable from the real OpenAI provider by name, so that `otherProvider()`'s keyed-provider failover (rate-limit handling in the agent loop) never treats a `compat:<model-id>` run as OpenAI and redirects it to `ANTHROPIC_API_KEY` (or vice versa).

#### Scenario: a compat provider is never eligible for the paid failover
- **GIVEN** a `compat:<model-id>` run against a configured endpoint, with `ANTHROPIC_API_KEY` present in the environment
- **WHEN** the endpoint returns a rate-limit response
- **THEN** the run does not fail over to `AnthropicProvider`; the compat provider's name is distinct from `'openai'` and `'anthropic'`

### Requirement: Model auto-selection refuses when ambiguous
`resolveModel()` SHALL refuse to guess a model when no explicit selection (`--model`, `COPPERHEAD_MODEL`, or `config.model`) is given and two or more of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are set, naming every credential found in the error. With exactly one such credential present, that provider SHALL still be selected automatically, as before. This is a breaking change from prior "first key wins" behavior, introduced alongside the compat route because a compat endpoint's key commonly sits in the same environment as `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, making silent mis-selection more likely.

#### Scenario: two credentials present with no explicit selection
- **GIVEN** both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are set, and no `--model`/`COPPERHEAD_MODEL`/`config.model`
- **WHEN** the model is resolved
- **THEN** resolution throws an "ambiguous" error naming both credential variables, instead of silently selecting one

#### Scenario: a single credential still auto-selects
- **GIVEN** exactly one of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set, and no explicit selection
- **WHEN** the model is resolved
- **THEN** that provider is selected automatically, unchanged from prior behavior

### Requirement: Provider parity covers the compatible endpoint
AC-3.10 provider parity SHALL include `--model compat:<model-id>` when a compatible endpoint and its credential are configured for the test run, and SHALL skip it otherwise so the default suite stays offline.

#### Scenario: the live matrix runs the compat provider only when configured
- **GIVEN** `COPPERHEAD_TEST_COMPAT_MODEL` and `COPPERHEAD_BASE_URL` are both set
- **WHEN** the live acceptance suite runs
- **THEN** the AC-3.x cases execute against that endpoint; absent either variable, they are skipped
