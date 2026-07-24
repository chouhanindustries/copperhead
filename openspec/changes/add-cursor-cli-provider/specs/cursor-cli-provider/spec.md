# cursor-cli-provider — Delta Spec

## ADDED Requirements

### Requirement: Saved-login cursor provider

copperhead SHALL provide a `cursor` provider, selected by `--model cursor` or `--model cursor:<model-id>`, that drives the locally installed Cursor Agent CLI and reuses its saved login (`agent login`). Running with this provider SHALL NOT require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. copperhead SHALL NOT read, copy, or log credentials.

#### Scenario: cursor runs without API keys
- **WHEN** `do "<request>" --model cursor` runs with a logged-in Cursor CLI and no OpenAI/Anthropic keys
- **THEN** the run uses the `cursor` provider and proceeds through the normal agent loop

### Requirement: Reasoning-only enforcement

The `cursor` provider SHALL run the CLI in plan mode with sandbox enabled and an isolated workspace. copperhead's tool catalog SHALL be advertised via the shared JSON prompt protocol. If the CLI output indicates native tool execution or file mutation, the provider SHALL throw and fail the run.

#### Scenario: Tripwire on native tool execution
- **WHEN** the CLI JSON stream contains a native tool/mutation event
- **THEN** `chat()` throws before returning tool calls to the loop

### Requirement: Malformed model output is tolerated

When the model reply does not contain a parseable copperhead tool-call JSON object, the provider SHALL return assistant text with empty `toolCalls` rather than throwing.

### Requirement: No silent fallback to a paid API

A rate-limited or errored `cursor` run SHALL NOT continue on OpenAI/Anthropic providers.

#### Scenario: Missing CLI or auth
- **WHEN** `agent` is not found or the user is not logged in
- **THEN** the run fails with an actionable message referencing `agent login` / `agent status` and `COPPERHEAD_CURSOR_PATH`
