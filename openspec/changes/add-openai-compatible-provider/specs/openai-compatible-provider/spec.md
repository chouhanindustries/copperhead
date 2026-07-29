# openai-compatible-provider — Delta Spec

## ADDED Requirements

### Requirement: Configurable endpoint and credential variable
The OpenAI provider SHALL accept a `baseURL` and pass it to its client, so any OpenAI-compatible endpoint can serve the agent loop with no code change. It SHALL read its credential from a configurable environment variable name (`apiKeyEnv`), defaulting to `OPENAI_API_KEY`. The variable *name* is configured; the credential itself SHALL live only in the environment.

#### Scenario: pointing at a third-party compatible endpoint
- **GIVEN** `baseURL` is `https://api.groq.com/openai/v1` and `apiKeyEnv` is `GROQ_API_KEY`, with `GROQ_API_KEY` set
- **WHEN** a run starts with `--model compat:qwen-3-coder`
- **THEN** the provider issues its requests to that base URL, using the model id `qwen-3-coder` and the key read from `GROQ_API_KEY`

#### Scenario: an unrelated key does not satisfy a configured endpoint
- **GIVEN** `apiKeyEnv` is `GROQ_API_KEY` and only `OPENAI_API_KEY` is set
- **WHEN** the provider is constructed
- **THEN** it fails, naming `GROQ_API_KEY` as the variable it expected

### Requirement: A local endpoint needs no credential
The provider SHALL require a credential only when the resolved endpoint is remote. A loopback endpoint (for example a local Ollama server) SHALL be usable with no key set.

#### Scenario: a local endpoint needs no credential
- **GIVEN** `baseURL` points at a loopback host such as `http://localhost:11434/v1`
- **WHEN** a run starts with `--model compat:<model-id>` and no API key is set
- **THEN** the provider is constructed successfully and issues its request to that endpoint

#### Scenario: a remote endpoint without its key fails fast
- **GIVEN** `baseURL` is a remote host and `apiKeyEnv` names a variable that is not set
- **WHEN** the provider is constructed
- **THEN** it throws an error naming the expected environment variable, before any network call

### Requirement: `compat` routing is explicit
`makeProvider()` SHALL route `compat:<model-id>` to the OpenAI provider configured with the resolved `baseURL` and `apiKeyEnv`. Unlike `codex`/`claude-code`/`cursor`, the bare form has no default: `makeProvider()` SHALL reject both `compat` (no model id) and `compat:` (empty model id), each with an actionable message. No other model value SHALL consult `baseURL`.

#### Scenario: a missing model id is rejected
- **WHEN** `--model compat` is resolved
- **THEN** the run fails with a message stating a compatible endpoint has no default model, and to use `compat:<model-id>`

#### Scenario: an empty override is rejected
- **WHEN** `--model compat:` is resolved
- **THEN** the run fails with a message telling the user to use `compat:<model-id>`

#### Scenario: a stray base URL never redirects a keyed OpenAI run
- **GIVEN** `COPPERHEAD_BASE_URL` is exported in the environment
- **WHEN** a run starts with `--model gpt-5`
- **THEN** the provider targets the default OpenAI endpoint, because only the `compat` route consults `baseURL`

### Requirement: Compat cache entries are endpoint-scoped
The response cache SHALL key a `compat:<model-id>` turn on its resolved `baseURL` as well as its model id and conversation, since a model id is not unique across hosts (Groq, OpenRouter, and others commonly serve overlapping ids). The cache key for a non-`compat` run SHALL NOT depend on `baseURL`, matching the same isolation as request routing (AC-3.16): only the explicit `compat` route reads it.

#### Scenario: switching a compat run's endpoint misses the previous host's cache
- **GIVEN** a cached turn for `compat:llama-3.1-8b-instant` against `https://api.groq.com/openai/v1`
- **WHEN** the same conversation is re-run as `compat:llama-3.1-8b-instant` against `https://openrouter.ai/api/v1`
- **THEN** the cache misses and the new endpoint is called, rather than replaying Groq's cached response

#### Scenario: a non-compat run's cache is unaffected by baseURL
- **GIVEN** a cached turn for `gpt-5` from before this endpoint-scoping existed
- **WHEN** the same conversation is re-run as `gpt-5`, regardless of any `COPPERHEAD_BASE_URL` set in the environment
- **THEN** the cache hits exactly as it did before, since a non-`compat` model's key never includes `baseURL`
