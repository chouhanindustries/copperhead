# agent-core — Delta Spec

## MODIFIED Requirements

Provider list (§4.4) SHALL include: `openai.ts` gains an optional `baseURL`
and configurable API-key env-var name, selected only via the explicit
`compat`/`compat:<model-id>` model prefix — no other model id ever consults
these settings. A provider constructed with `baseURL` set SHALL report a
distinct `name` (`'openai-compat'`) from plain OpenAI (`'openai'`), so the
rate-limit failover path (`otherProvider()`) never redirects a compat-endpoint
run to a real, paid keyed provider. A local/loopback endpoint (`localhost`,
`127.0.0.1`, `::1`, `*.local`) SHALL NOT require an API key.

Model selection (§4.4 "Selection"): with no `--model`/`COPPERHEAD_MODEL`/
`config.model` and **two or more** of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
present, resolution SHALL refuse with an actionable `ambiguous:` error naming
the credentials found, rather than silently selecting one. With exactly one
key present, selection proceeds as before.

AC-3.10 provider parity SHALL include `--model compat:<model-id>` when a
compatible endpoint (`COPPERHEAD_BASE_URL`/`openaiCompatBaseUrl` and, unless
the endpoint is local, its key) is configured.

## ADDED Requirements

### Requirement: Compat-endpoint runs never fail over to a paid keyed provider

A `compat:<model-id>` run's provider SHALL be structurally ineligible for
`otherProvider()`'s openai↔anthropic rate-limit failover.

#### Scenario: A rate-limited compat run does not fail over

- **WHEN** a `do` run on `--model compat:<id>` hits a rate limit and
  `ANTHROPIC_API_KEY` happens to be set in the same environment
- **THEN** the run does not silently continue on the Anthropic provider; it
  fails through the same non-keyed-provider path saved-login providers
  (`codex`, `cursor`, `claude-code`) already use

### Requirement: Ambiguous credentials refuse rather than guess

#### Scenario: Two credentials, no explicit model

- **WHEN** neither `--model` nor `COPPERHEAD_MODEL` nor `config.model` is set,
  and both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are present in the
  environment
- **THEN** model resolution throws an error whose message starts with
  `ambiguous:` and names both credential variables, rather than resolving to
  either provider

#### Scenario: A single credential still resolves silently

- **WHEN** exactly one of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is present and
  nothing else selects a model
- **THEN** resolution succeeds on that provider, unchanged from before this
  requirement existed
