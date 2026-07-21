# agent-core: Delta Spec

## MODIFIED Requirements

### Requirement: Provider-agnostic tool-use loop
The agent core SHALL implement a tool-use loop behind a `Provider` interface (`chat(messages, tools, opts) -> Turn`) with direct OpenAI API, Anthropic API, and local Codex CLI implementations. The Codex implementation SHALL use the official Codex SDK with the locally installed CLI and its saved login, and SHALL NOT require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

#### Scenario: Codex saved-login run
- **WHEN** an authenticated local Codex CLI is available and the user runs `copperhead do "<request>" --model codex` with no model API keys
- **THEN** the agent loop uses the Codex provider, completes model turns through the saved ChatGPT login, and records `provider: codex` in the transcript

#### Scenario: Explicit Codex model
- **WHEN** the user selects `--model codex:<model-id>`
- **THEN** the Codex thread uses that model id while all other Codex provider behavior remains unchanged

#### Scenario: Provider parity
- **WHEN** the net-rename integration test runs with each configured provider, including `--model codex`
- **THEN** every run has the same observable gated outcome

## ADDED Requirements

### Requirement: Codex cannot bypass Copperhead tools
The Codex provider SHALL run with a read-only sandbox, approval policy `never`, model-initiated network access and web search disabled, and an isolated working directory. Every requested action SHALL be returned as structured output and dispatched by Copperhead.

#### Scenario: Edit tools remain structurally absent
- **WHEN** a Codex turn occurs before its OpenSpec proposal validates
- **THEN** the structured output schema's tool-name enum contains no `edit_file` or `write_file`, and a returned unavailable tool name is rejected before dispatch

#### Scenario: Native Codex edit is impossible
- **WHEN** Codex processes any Copperhead turn
- **THEN** its native sandbox cannot write the target repository and only Copperhead's gated tool dispatcher can mutate files

### Requirement: Codex authentication remains external
Copperhead SHALL invoke the installed Codex CLI and allow it to manage saved authentication. Copperhead SHALL NOT read, copy, serialize, or log the saved ChatGPT credential.

#### Scenario: Missing login is actionable
- **WHEN** `--model codex` is selected but the CLI is missing or unauthenticated
- **THEN** the run fails through the normal rollback path with an error directing the user to check `codex login status`
