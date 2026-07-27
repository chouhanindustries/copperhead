# copperhead-serve (delta)

Scenarios map onto AC-114B.1 through AC-114B.4 and AC-114B.8 in the proposal.

## ADDED Requirements

### Requirement: NDJSON handshake and protocol hygiene
`copperhead serve` SHALL communicate exclusively in NDJSON (one JSON object per line) over stdio. On startup it SHALL emit exactly one `hello` object carrying the protocol version, copperhead version, resolved repo root, and resolved model, then wait for requests. A line that is not valid JSON or names an unknown method SHALL produce an `error` object referencing the offending input and SHALL NOT terminate the process. When stdin reaches EOF, serve SHALL exit.

#### Scenario: Handshake (AC-114B.1)
- **WHEN** `copperhead serve` starts in a configured repo
- **THEN** the first stdout line is a `hello` NDJSON object with protocol version, copperhead version, repo root, and model, and no further output is produced until a request arrives

#### Scenario: Malformed input (AC-114B.1)
- **WHEN** a client sends a line that is not valid JSON, or a valid object with an unknown method
- **THEN** serve emits an `error` object and continues serving subsequent requests

#### Scenario: Consumer disappears
- **WHEN** stdin closes
- **THEN** serve exits instead of lingering as an orphan

### Requirement: Streamed gated runs
A `run` request SHALL execute one agent run through the same gated loop as `copperhead do` (spec-gated in, verification-gated out), streaming `log` events for run output as it happens and ending with exactly one `result` object carrying the outcome (`success`/`refused`/`failure`), summary, and files touched. Serve SHALL construct the KiCad IPC bridge as an attended surface, so runs receive selection context and the reload prompt per AC-114.

#### Scenario: Successful run streams then resolves (AC-114B.2)
- **WHEN** a client sends `{"id":"1","method":"run","params":{"request":"..."}}`
- **THEN** serve emits `log` events tagged with id "1" during the run, followed by exactly one `result` object with the outcome, summary, and files touched

#### Scenario: Run failure is a result, not a crash (AC-114B.2)
- **WHEN** a run fails (rollback path)
- **THEN** serve emits a `result` object with outcome `failure` and stays alive for further requests

### Requirement: Single-flight
Serve SHALL execute at most one run at a time. A `run` request arriving while a run is active SHALL be rejected with a `busy` error that does not disturb the active run. The protocol SHALL NOT offer a cancel method: the agent loop has no abort mechanism, so run interruption is the embedder terminating the serve process (the REPL's Ctrl+C semantics).

#### Scenario: Busy rejection (AC-114B.3)
- **WHEN** a second `run` arrives while the first is still executing
- **THEN** the second request receives a `busy` error and the first run continues to its normal outcome

### Requirement: Wire redaction
Every NDJSON object serve emits SHALL have secret-pattern strings (per AC-4.1) redacted before writing.

#### Scenario: Leaked key in run output (AC-114B.4)
- **WHEN** run output contains a string matching the secret pattern
- **THEN** the corresponding `log` event on the wire carries the redacted form

### Requirement: Offline protocol testability
All serve protocol behavior SHALL be testable in vitest without KiCad and without an LLM, via the same injected-runner seam the REPL tests use.

#### Scenario: CI coverage (AC-114B.8)
- **WHEN** the offline suite runs
- **THEN** handshake, streaming, single-flight, malformed input, EOF exit, and redaction are all exercised without network, KiCad, or provider credentials
