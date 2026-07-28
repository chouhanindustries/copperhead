# openai-compatible-provider — Delta Spec

## ADDED Requirements

### Requirement: Configurable OpenAI-compatible endpoint

copperhead SHALL support pointing its OpenAI provider at any OpenAI-compatible
REST endpoint (Groq, Cerebras, OpenRouter, Gemini's compat endpoint, a local
Ollama) via an endpoint base URL and a configurable API-key environment
variable name, without any code change. The base URL SHALL be settable via
`openaiCompatBaseUrl` in `.copperhead/config.json` or the `COPPERHEAD_BASE_URL`
environment variable (env overrides config). The credential env-var name
SHALL be settable via `openaiCompatApiKeyEnv` in config or
`COPPERHEAD_API_KEY_ENV` (env overrides config; defaults to `OPENAI_API_KEY`
when neither is set). Config.json SHALL store only the env-var *name*, never
a credential value.

#### Scenario: Endpoint and key resolve from config

- **WHEN** `.copperhead/config.json` sets `openaiCompatBaseUrl` and
  `openaiCompatApiKeyEnv`, and the named env var holds a value
- **THEN** a `compat:<model-id>` run sends its request to the configured
  endpoint using that credential

#### Scenario: Env vars override config fields

- **WHEN** both `.copperhead/config.json` and `COPPERHEAD_BASE_URL`/
  `COPPERHEAD_API_KEY_ENV` are set, to different values
- **THEN** the environment variables win

#### Scenario: A blank env var or config field does not override

- **WHEN** `COPPERHEAD_BASE_URL` (or `COPPERHEAD_API_KEY_ENV`) is present in
  the environment but set to an empty or whitespace-only string
- **THEN** resolution falls through to the config field or default, as if
  that environment variable were unset entirely

### Requirement: Local/loopback endpoints need no credential

An endpoint whose host is `localhost`, `127.0.0.1`, `::1`, or a `*.local`
hostname SHALL NOT require the configured credential environment variable to
be set; the provider SHALL construct and issue requests successfully with no
key present.

#### Scenario: A local Ollama endpoint requires no key

- **WHEN** `openaiCompatBaseUrl` is `http://localhost:11434/v1` and no
  corresponding credential env var is set
- **THEN** `compat:<model-id>` constructs successfully and the request
  reaches the endpoint

### Requirement: Prompt-privacy signal for compat endpoints

For a `compat:<model-id>` run, copperhead SHALL classify the configured
endpoint's host against a list of hosts documented as training on submitted
prompts, and surface a non-blocking signal — both in `copperhead doctor`
(preflight) and as a one-line notice logged at run-start (so a non-interactive
or unattended run's transcript carries it even when `doctor` was never run).
A true loopback endpoint (`localhost`/`127.0.0.1`/`::1`) SHALL be exempt from
this check entirely; a `*.local`/LAN hostname SHALL NOT be exempt, since that
traffic still leaves the originating machine even though it needs no
credential. OpenRouter's risk SHALL apply only to `:free`-suffixed model ids,
not to the host generally.

#### Scenario: Documented training-risk host warns

- **WHEN** the configured endpoint's host is `generativelanguage.googleapis.com`
  (or a subdomain of it)
- **THEN** both `doctor` and the run-start transcript notice report a
  training-risk warning, and the run is not blocked

#### Scenario: True loopback is exempt, LAN is not

- **WHEN** the configured endpoint's host is `localhost`/`127.0.0.1`/`::1`
- **THEN** no privacy signal is produced at all
- **WHEN** instead the host is a `.local`/LAN hostname (e.g. `nas.local`)
- **THEN** an informational "no policy on record" signal IS produced, since
  that request leaves the machine

#### Scenario: OpenRouter risk is model-suffix-specific

- **WHEN** the configured endpoint is `openrouter.ai` and the model id ends
  in `:free`
- **THEN** the warning fires
- **WHEN** instead the model id does not end in `:free`
- **THEN** no warning fires; an informational "no policy on record" signal
  is produced instead

### Requirement: No silent failover to a paid API for a compat endpoint

A provider constructed against a compat endpoint SHALL report a distinct
provider name from plain OpenAI, so the agent loop's rate-limit failover
(which swaps between the two *keyed* providers by exact name match) never
redirects a compat-endpoint run to a real, paid Anthropic (or OpenAI) key
present in the same environment.

#### Scenario: A 429 against a compat endpoint does not fail over

- **WHEN** a `do` run on a `compat:<model-id>` endpoint receives a rate-limit
  response and `ANTHROPIC_API_KEY` is set in the environment
- **THEN** the run does not continue on the Anthropic provider
