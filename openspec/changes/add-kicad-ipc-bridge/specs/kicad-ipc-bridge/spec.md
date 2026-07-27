# kicad-ipc-bridge (delta)

Scenarios map 1:1 onto AC-114.1 through AC-114.7 in the proposal.

## ADDED Requirements

### Requirement: Opportunistic connection with graceful degradation
The REPL SHALL attempt to connect to a running KiCad instance's IPC API at startup, preferring `KICAD_API_SOCKET`/`KICAD_API_TOKEN` env vars and falling back to the platform's well-known socket path, and SHALL treat every bridge failure (absent socket, disabled API server, timeout, decode error, version mismatch) as a soft "not connected" state that never fails a command or run. The connection state SHALL be shown in the REPL observability row, and the client SHALL re-probe periodically so a KiCad started after the REPL still connects.

#### Scenario: KiCad running with API enabled (AC-114.1)
- **WHEN** the REPL is started while KiCad is running with its API server enabled
- **THEN** the observability row shows a connected `kicad:` state within 5 seconds

#### Scenario: No KiCad running (AC-114.1)
- **WHEN** the REPL is started with no KiCad running or with the API server disabled
- **THEN** the observability row shows the disconnected state, startup is not measurably delayed, and all other REPL behavior is unchanged from a build without the bridge

#### Scenario: KiCad dies mid-run (AC-114.5)
- **WHEN** the connected KiCad exits while an agent run is in progress
- **THEN** any in-flight bridge tool call returns a soft error string, the run continues to a normal verdict, and the observability row switches to the disconnected state

### Requirement: Connection-gated read-only context tools
The agent's tool list SHALL include `get_kicad_selection` and `get_open_documents` only while a KiCad IPC connection is live; while disconnected the tools SHALL be structurally absent from the tool list rather than present and erroring. Both tools SHALL be read-only: neither SHALL mutate KiCad state, project files, or documents.

#### Scenario: Tools present while connected (AC-114.2)
- **WHEN** an agent turn starts while the KiCad connection is live
- **THEN** the tool list offered to the model contains `get_kicad_selection` and `get_open_documents`, and the run transcript records them

#### Scenario: Tools absent while disconnected (AC-114.2, AC-114.5)
- **WHEN** an agent turn starts while no KiCad connection is live (including after a mid-run disconnect)
- **THEN** neither tool name appears in the tool list offered to the model

### Requirement: Selection context injection at turn start
At the start of each user turn, the REPL SHALL snapshot the current pcbnew selection from the connected KiCad and inject it into the agent's context as a labeled block containing the selected items' references and nets, marked as possibly irrelevant to the request. An empty selection SHALL inject nothing.

#### Scenario: Items selected (AC-114.3)
- **WHEN** the user submits a prompt while board items are selected in the connected pcbnew
- **THEN** the turn's context contains a labeled selection block listing those items' references and nets

#### Scenario: Nothing selected (AC-114.3)
- **WHEN** the user submits a prompt while nothing is selected in the connected pcbnew
- **THEN** no selection block is injected into the turn's context

### Requirement: Post-run reload prompt for open boards
After a committed run whose file writes modified a board file that is open in the connected KiCad, the run log SHALL print a reload prompt naming that file. The system SHALL NOT reload or refresh the document automatically: the pinned API (KiCad 10.0.5) exposes neither a reload-from-disk call nor a dirty-state query, so any forced action could discard unsaved in-editor work.

#### Scenario: Open board modified (AC-114.4)
- **WHEN** a committed run modifies a board file that is open in the connected KiCad
- **THEN** the run log prints a reload prompt naming the file, and no API-side reload or refresh is triggered

#### Scenario: No open board affected (AC-114.4)
- **WHEN** a committed run touches only schematic or doc files, or the touched board is not open in the connected KiCad
- **THEN** no reload prompt is printed

### Requirement: Bridge isolation from LLM-free commands
`check` (and its `verify` alias), `sync`, and `create` SHALL never construct an IPC client or open the IPC socket. The bridge SHALL be reachable only from the REPL and `do` paths, preserving the contract that `check` is LLM-free and network-free.

#### Scenario: No socket activity from gated commands (AC-114.6)
- **WHEN** `check`, `sync`, and `create` run while a fake IPC server is listening on the well-known socket path
- **THEN** the fake server records zero connection attempts

### Requirement: Offline testability with opt-in live suite
All bridge scenarios SHALL be testable offline against a fake IPC server replaying recorded protobuf frames over a temporary socket, with no KiCad installed. Tests against a real KiCad instance SHALL run only when `COPPERHEAD_TEST_KICAD_IPC=1` is set.

#### Scenario: Offline suite (AC-114.7)
- **WHEN** the test suite runs on a machine with no KiCad installed and `COPPERHEAD_TEST_KICAD_IPC` unset
- **THEN** all bridge scenario tests run against the fake IPC server and pass, and no live KiCad test executes

#### Scenario: Live suite opt-in (AC-114.7)
- **WHEN** the test suite runs with `COPPERHEAD_TEST_KICAD_IPC=1` and a running KiCad
- **THEN** the live bridge tests execute against the real instance
