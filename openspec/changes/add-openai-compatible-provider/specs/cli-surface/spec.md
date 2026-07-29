# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `compat` model selection and endpoint configuration
`--model`, `COPPERHEAD_MODEL`, and the `model` field in `.copperhead/config.json` SHALL accept `compat` and `compat:<model-id>`, routing to the OpenAI provider against the configured compatible endpoint. `.copperhead/config.json` SHALL accept `baseURL` (string) and `apiKeyEnv` (string), overridable by `COPPERHEAD_BASE_URL` and `COPPERHEAD_API_KEY_ENV` respectively, with the environment taking precedence over config.

#### Scenario: environment overrides config
- **GIVEN** `baseURL` is set in `.copperhead/config.json` and `COPPERHEAD_BASE_URL` is exported
- **WHEN** compatible-endpoint settings are resolved
- **THEN** the environment value wins, matching the precedence direction of every other copperhead setting

## MODIFIED Requirements

### Requirement: `doctor` credential check covers the compatible endpoint
`copperhead doctor` SHALL, for the compat route, check the presence of the configured credential variable rather than `OPENAI_API_KEY`, and SHALL report the resolved endpoint in its provider line. A loopback endpoint SHALL pass with no credential. `doctor` SHALL make no network request to verify the endpoint or the credential; an unreachable endpoint or an invalid key SHALL surface on the first real run instead.

#### Scenario: doctor never makes a network request
- **GIVEN** a configured compatible endpoint, reachable or not
- **WHEN** `copperhead doctor` runs
- **THEN** no network request is made and no endpoint reachability line is reported

#### Scenario: compat credential is resolved by configured variable name
- **GIVEN** `apiKeyEnv` is `GROQ_API_KEY` and that variable is set
- **WHEN** `copperhead doctor --model compat:<model-id>` runs
- **THEN** the provider check passes and its detail names `GROQ_API_KEY` and the resolved endpoint

### Requirement: `doctor` warns about prompt-training risk without failing
`copperhead doctor` SHALL emit a `warn`-level line when the configured endpoint's host is one documented as training on submitted prompts, and SHALL NOT fail the run for that reason alone. For a host with no policy on record it SHALL say so explicitly rather than implying the endpoint is safe. A true loopback endpoint (`localhost`, `127.0.0.1`, `::1`) SHALL bypass this check entirely; a `.local`/LAN host SHALL NOT, since that traffic leaves the machine.

#### Scenario: a training-risk host warns without failing
- **GIVEN** the configured endpoint's host is documented as training on free-tier prompts
- **WHEN** `copperhead doctor --model compat:<model-id>` runs with the credential present
- **THEN** a `warn` line reports the risk and the command still exits 0

#### Scenario: a true loopback endpoint skips the privacy check entirely
- **GIVEN** the configured endpoint is `localhost`, `127.0.0.1`, or `::1`
- **WHEN** `copperhead doctor --model compat:<model-id>` runs
- **THEN** no privacy line is reported at all — a `.local`/LAN host at the same command still gets the `warn`/`info` treatment above, since it is not true loopback
