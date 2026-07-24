# lmstudio-provider — Delta Spec

## ADDED Requirements

### Requirement: Local provider needs no API key
copperhead SHALL provide an `lmstudio` provider, selected by `--model lmstudio` or `--model lmstudio:<model-id>`, that drives a local OpenAI-compatible model server. Running with this provider SHALL NOT require `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or any other credential, and SHALL NOT require a vendor account. The API key transmitted to the local server SHALL be a fixed placeholder, and SHALL NOT be read from the environment, so a local run cannot carry a cloud credential to the configured host.

#### Scenario: Run with no API key
- **WHEN** `do "<request>" --model lmstudio` runs against a local server with a tool-capable model loaded, and neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is present
- **THEN** the run proceeds against the local model and completes through the normal verify/commit path, and no request is made to any cloud model host

#### Scenario: A cloud key is never forwarded to the local endpoint
- **WHEN** an `lmstudio` turn runs while `OPENAI_API_KEY` is also set in the environment
- **THEN** the request to the configured endpoint carries the fixed placeholder credential and not the value of `OPENAI_API_KEY`

### Requirement: Configurable local endpoint
The provider SHALL default to `http://localhost:1234/v1` and SHALL accept an override via the `LMSTUDIO_BASE_URL` environment variable. The endpoint SHALL be supplied by environment or configuration and SHALL NOT be committed to the repository. Any server speaking the OpenAI chat-completions protocol with tool calling SHALL be usable through this override.

#### Scenario: Default endpoint
- **WHEN** `--model lmstudio` is resolved with `LMSTUDIO_BASE_URL` unset
- **THEN** requests are sent to `http://localhost:1234/v1`

#### Scenario: Overridden endpoint
- **WHEN** `LMSTUDIO_BASE_URL` names a different host or port (for example an Ollama or vLLM server)
- **THEN** requests are sent there instead, and the default is not used

### Requirement: The loaded model is identified, not assumed
When the model id is given explicitly as `lmstudio:<model-id>`, the provider SHALL send that id. When bare `lmstudio` is used, the provider SHALL ask the server which model is loaded, SHALL use the first model reported, and SHALL reuse that answer for the remainder of the run rather than asking again per turn. The resolved id SHALL be the model id used in run metadata and in the response-cache key, so two different local models do not share cached turns.

#### Scenario: Bare lmstudio discovers the loaded model once
- **WHEN** a multi-turn `lmstudio` run executes with no explicit model id
- **THEN** the server is asked for its model list exactly once, and every turn is sent with the discovered model id

#### Scenario: An explicit model id is used verbatim
- **WHEN** `--model lmstudio:<model-id>` is resolved
- **THEN** that id is sent to the server and no model-discovery request is made

### Requirement: No silent fallback to a billed provider
An `lmstudio` run that is rate-limited or errors SHALL NOT be silently continued on a keyed (`gpt-5`/`claude`) provider, even when those keys are present in the environment. The provider SHALL preserve the underlying error's status so copperhead's retry/backoff still applies, but the provider-swap failover SHALL NOT select a keyed provider for an `lmstudio` run.

#### Scenario: A failing local run does not become a billed run
- **WHEN** an `lmstudio` turn fails or is rate-limited while `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both set
- **THEN** copperhead applies its normal retry handling and, on exhaustion, fails the run rather than switching to `gpt-5` or `claude`

### Requirement: Local-server failures produce actionable errors
When the local server is unreachable, is reachable but has no model loaded, or rejects the request because the loaded model does not support tool calling, the provider SHALL surface an actionable error naming the condition and the configured endpoint, and the run SHALL fail through copperhead's normal rollback path leaving the tree unchanged — never a raw stack trace with no guidance. Errors that are not one of these diagnosable conditions SHALL be re-thrown unchanged so their status survives for retry classification.

#### Scenario: Server not running
- **WHEN** `--model lmstudio` is used with no server listening at the configured endpoint
- **THEN** the run fails with a message naming the endpoint and how to start the server or change `LMSTUDIO_BASE_URL`, and the working tree is unchanged

#### Scenario: Server running with no model loaded
- **WHEN** the server responds but reports no loaded model
- **THEN** the run fails with a message saying the server is reachable but has no model loaded, and suggesting an explicit `lmstudio:<model-id>`

#### Scenario: Loaded model cannot do tool calling
- **WHEN** the server rejects the request because the loaded model does not support tools
- **THEN** the run fails with a message stating that a tool-capable model is required

#### Scenario: A rate limit keeps its status
- **WHEN** the local server returns HTTP 429
- **THEN** the error reaches copperhead's retry layer with its status intact and is handled as a rate limit, not as a local-server misconfiguration

### Requirement: Tool calls written as text are steered, not silently dropped
The provider SHALL dispatch only native tool calls. When a turn advertised tools, produced no tool calls, and its text contains a tool call naming a tool in that turn's advertised catalog, the provider SHALL return a nudge instructing the model to emit a native tool call and noting that the loaded model may not be tool-capable. A tool name outside the current catalog SHALL NOT trigger a nudge.

#### Scenario: Model writes a tool call as prose
- **WHEN** an `lmstudio` turn advertises `read_file` and the model replies with a JSON block naming `read_file` instead of emitting a tool call
- **THEN** `chat()` returns a `Turn` with no tool calls and a nudge naming that tool, so the loop steers the model rather than treating the turn as a stall

#### Scenario: Genuine prose is left alone
- **WHEN** an `lmstudio` turn returns ordinary prose that names no advertised tool
- **THEN** the `Turn` carries that text with no nudge and no tool calls

### Requirement: Safety gates apply to lmstudio
Every mutation made during an `lmstudio` run SHALL flow through copperhead's capability-filtered tools, obligations ledger, ERC/DRC verification, git snapshot, and commit gate, exactly as for the keyed providers. The structural spec-gating invariant SHALL be unaffected: the tools advertised each turn are exactly those `availableTools(ctx)` returned.

#### Scenario: Rollback on persistent violations
- **WHEN** an `lmstudio` run's edits leave ERC/DRC violations that persist past `maxRepairCycles`
- **THEN** the working tree is restored byte-identical to the pre-run state and the run exits non-zero, identical to the behavior with `gpt-5` or `claude`

#### Scenario: Locked edit tools are not advertised
- **WHEN** an `lmstudio` turn runs before the change proposal has validated
- **THEN** the edit tools (`edit_file`, `write_file`) are absent from the tool list sent to the local server, and any attempt to call them is refused by `dispatchTool`

### Requirement: The verification path stays LLM-free and network-free
Adding a local provider SHALL NOT make `check` (alias `verify`) or the BOM export reach any model backend. The provider SHALL be reachable only through the agent loop's provider construction, and SHALL NOT be imported, directly or transitively, by the `check` command's module graph.

#### Scenario: check makes no model call to any host
- **WHEN** `copperhead check` runs in a repo configured with `model: "lmstudio"` and a local server running
- **THEN** no request is made to the local server or to any cloud host, and the command completes exactly as it would with any other configured model
