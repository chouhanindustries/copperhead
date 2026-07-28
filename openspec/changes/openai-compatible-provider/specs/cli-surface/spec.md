# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `compat:<model-id>` model selection value

`--model`, `COPPERHEAD_MODEL`, and `.copperhead/config.json`'s `model` field
SHALL accept `compat` and `compat:<model-id>`, routed to the OpenAI-compatible
provider path in `makeProvider()`. This SHALL be the only accepted model
value that consults `openaiCompatBaseUrl`/`openaiCompatApiKeyEnv` (or their
`COPPERHEAD_BASE_URL`/`COPPERHEAD_API_KEY_ENV` env-var overrides); every other
model id SHALL ignore them entirely.

#### Scenario: compat:<id> routes to the compatible-endpoint provider

- **WHEN** `--model compat:llama-3.3-70b-versatile` resolves with
  `openaiCompatBaseUrl`/`COPPERHEAD_BASE_URL` configured
- **THEN** the run uses the OpenAI provider pointed at that endpoint, with a
  provider `name` of `'openai-compat'`

#### Scenario: A configured endpoint never redirects a plain model id

- **WHEN** `openaiCompatBaseUrl`/`COPPERHEAD_BASE_URL` is configured and
  `--model gpt-5` (or `claude`, or any id without the `compat` prefix) is
  passed
- **THEN** the run uses the real OpenAI (or Anthropic) API, ignoring the
  configured compat endpoint entirely

#### Scenario: Bare `compat` and a missing endpoint both refuse with an actionable error

- **WHEN** `--model compat` is passed with no model id, or `--model
  compat:<id>` is passed with no endpoint configured
- **THEN** the run refuses to start with an error naming what is missing,
  rather than silently defaulting to a literal `gpt-5` model id sent to the
  configured host, or falling back to the real OpenAI API

### Requirement: `copperhead doctor` reports compat-endpoint credential and privacy status

`copperhead doctor`'s `provider` check, for a `compat:<model-id>` model,
SHALL report whether the configured endpoint's credential env var is set
(skipped for a local/loopback endpoint), and a separate `privacy` check
SHALL report `[warn]` for a documented training-risk host or `[info]` naming
the host when no policy is on record. Neither the credential check's local-
endpoint case nor the privacy check ever produces a `[FAIL]`; `doctor` stays
network-free — it does not probe the endpoint.

#### Scenario: Local endpoint needs no credential and no privacy line

- **WHEN** `doctor` resolves a `compat:<id>` model against a `localhost`/
  `127.0.0.1`/`::1` endpoint
- **THEN** the `provider` check reports `[ok]` with no credential required,
  and no `privacy` row is emitted at all

#### Scenario: Training-risk endpoint warns without failing

- **WHEN** `doctor` resolves a `compat:<id>` model against a documented
  training-risk host (e.g. Gemini's endpoint) with its credential set
- **THEN** the `privacy` check reports `[warn]` and the overall report is
  still `ready` (exit 0)

#### Scenario: A credential embedded in the endpoint URL is not displayed

- **WHEN** the configured `openaiCompatBaseUrl` embeds a credential as a
  query parameter (e.g. `?key=...`)
- **THEN** the doctor report's `provider` detail shows only the endpoint's
  origin and path, never the query string or embedded credential
