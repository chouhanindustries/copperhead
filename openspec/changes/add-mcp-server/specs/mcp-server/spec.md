# mcp-server — Delta Spec

## ADDED Requirements

### Requirement: Stdio MCP server exposing opaque pipeline tools
`copperhead mcp` SHALL start a stdio MCP server exposing exactly four tools: `copperhead_check`, `copperhead_do`, `copperhead_sync`, and `copperhead_init`. The server SHALL expose no file-edit, raw-KiCad, or partial-loop tools, and SHALL open no network transport.

#### Scenario: Tool list is the whole surface
- **WHEN** an MCP host requests the tool list
- **THEN** exactly the four named tools are returned, each with a JSON schema for inputs and a description stating what the pipeline guarantees

#### Scenario: No bypass surface exists
- **WHEN** the server's registered tools are enumerated in tests
- **THEN** no tool can mutate a repo file except by running the full gated `do`/`sync` pipeline

### Requirement: copperhead_check tool
`copperhead_check` SHALL run the LLM-free `check` pipeline on the configured repo, accept optional boolean inputs `fab` and `strict`, and return the same structured report as `check --json`.

#### Scenario: Check over MCP matches CLI
- **WHEN** `copperhead_check` runs on the fixture repo
- **THEN** the tool result equals the output of `copperhead check --json` on the same repo state

### Requirement: copperhead_do tool
`copperhead_do` SHALL accept a change-request string (and optional `dry_run` boolean), run the full gated loop non-interactively (AUTO marker), emit MCP progress notifications while the run proceeds, and return a run summary containing at minimum: status (`committed`, `rolled_back`, or `refused`), commit hash when committed, files touched, verification results, and the transcript path. Intermediate loop steps SHALL NOT be exposed as tool interactions.

#### Scenario: Successful run returns a committed summary
- **WHEN** `copperhead_do` completes a change that passes verification
- **THEN** the result has status `committed`, the commit hash, the files touched, and the transcript path

#### Scenario: Rollback is a result, not an error
- **WHEN** violations persist past `maxRepairCycles` during a `copperhead_do` run
- **THEN** the tool call succeeds at the protocol level and the result has status `rolled_back` with the transcript path, and the working tree is byte-identical to the pre-run state

### Requirement: copperhead_sync tool
`copperhead_sync` SHALL run the deterministic verify phase and return the inconsistency report; it SHALL run the LLM resolve phase only when the boolean input `resolve` is true, with requirement violations flagged and never silently resolved, per the sync contract.

#### Scenario: Verify-only by default
- **WHEN** `copperhead_sync` is called without `resolve`
- **THEN** the result is the full inconsistency report and no repo file changes

### Requirement: Key handling and honest degradation
The server SHALL read API keys only from environment variables. `copperhead_check` and `copperhead_init` SHALL work with no key present; `copperhead_do` and `copperhead_sync` with `resolve: true` SHALL return a typed error naming the missing environment variable. Keys SHALL never be accepted as tool inputs nor appear in any tool result.

#### Scenario: Keyless host can still verify
- **WHEN** no API key env var is set and `copperhead_check` is called
- **THEN** the check runs and returns its report

#### Scenario: Keyless do degrades honestly
- **WHEN** no API key env var is set and `copperhead_do` is called
- **THEN** the result is a typed error naming the expected env vars, and no run is started

### Requirement: Mutating tools are serialized per repo
The server SHALL serialize `copperhead_do`, `copperhead_sync` (with `resolve`), and `copperhead_init` calls against the same repo, queueing or rejecting concurrent mutations with a typed busy error, while allowing concurrent `copperhead_check` calls.

#### Scenario: Concurrent do calls do not interleave
- **WHEN** a second `copperhead_do` arrives while one is running
- **THEN** it is queued or receives a typed busy error, and the repo never sees interleaved runs
