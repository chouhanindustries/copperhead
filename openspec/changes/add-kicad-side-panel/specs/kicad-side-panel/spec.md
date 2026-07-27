# kicad-side-panel (delta)

Scenarios map onto AC-114B.5 through AC-114B.8 in the proposal.

## ADDED Requirements

### Requirement: Dockable pane in pcbnew
The addon SHALL register a pcbnew action plugin (KiCad 9/10 SWIG plugin system) that docks a pane titled "copperhead" into the pcbnew frame via wx AUI. Repeated invocation SHALL toggle the pane's visibility. If the frame's AUI manager cannot be found, the pane SHALL open as a floating window rather than failing. Serve I/O SHALL never run on the wx main thread: a reader thread posts updates to the UI via `wx.CallAfter`.

#### Scenario: Dock and toggle (AC-114B.5)
- **WHEN** the user invokes the copperhead action in pcbnew twice
- **THEN** the pane docks and shows on the first invocation and hides on the second, and the pcbnew UI stays responsive throughout

#### Scenario: AUI lookup fails (AC-114B.5)
- **WHEN** the pcbnew frame's AUI manager cannot be located on the running platform
- **THEN** the pane opens floating and remains fully functional

### Requirement: Serve process lifecycle and environment forwarding
With a copperhead CLI available (on PATH or configured), the pane SHALL spawn `copperhead serve` in the open board's project directory, forward `KICAD_API_SOCKET` and `KICAD_API_TOKEN` from its environment, display the repo root echoed by the `hello` reply, and restart the child (with a visible notice) if it exits unexpectedly. With no CLI available, the pane SHALL show an install hint and no run controls.

#### Scenario: CLI present (AC-114B.6)
- **WHEN** the pane opens in a pcbnew with a board open and `copperhead` on PATH
- **THEN** `copperhead serve` is spawned in the board's project directory with the KiCad API env vars forwarded, and the pane shows the repo root and model from the handshake

#### Scenario: CLI missing (AC-114B.6)
- **WHEN** no copperhead CLI is on PATH and none is configured
- **THEN** the pane renders an install hint and disables the request input instead of erroring

### Requirement: Run interaction surface
The pane SHALL provide a request input, a scrolling run log fed by `log` events, a status row (model, run state, latest outcome), and a stop control that terminates the serve child and restarts it (the REPL Ctrl+C equivalent; the protocol has no cancel method by design). While a run is active the request input SHALL be disabled (single-flight mirrors serve). Outcomes SHALL be visibly distinguished (success/refused/failure).

#### Scenario: One run, visible lifecycle (AC-114B.5)
- **WHEN** the user submits a request in the pane
- **THEN** the input disables, log lines stream into the pane as they happen, and the status row shows the terminal outcome when the `result` arrives, re-enabling the input

### Requirement: PCM packaging
A checked-in build script SHALL produce a Plugin and Content Manager zip: `metadata.json` (identifier, name, description, version equal to package.json's version, kicad version bounds spanning 9.0 through 10.x), the plugin sources under `plugins/`, and an icon under `resources/`. The zip layout SHALL install the pane through KiCad's addon manager without manual file placement.

#### Scenario: Build and validate (AC-114B.7)
- **WHEN** the build script runs
- **THEN** the produced zip contains metadata.json with the package.json version and 9.0–10.* kicad bounds, plugin sources under plugins/, and an icon under resources/

#### Scenario: Offline packaging test (AC-114B.8)
- **WHEN** the offline suite runs
- **THEN** the packaging scenario above is verified by unzipping the artifact in a temp dir, with no KiCad involved

### Requirement: Manual verification checklist for live pcbnew behavior
Pane behavior that requires a running pcbnew (docking, toggling, threading, env forwarding) SHALL be covered by a written checklist in `plugins/kicad/TESTING.md`, analogous to the live IPC suite's role for the Phase A bridge.

#### Scenario: Checklist exists and maps to ACs (AC-114B.8)
- **WHEN** a maintainer prepares a release containing panel changes
- **THEN** `plugins/kicad/TESTING.md` enumerates steps covering AC-114B.5 and AC-114B.6 against a real pcbnew
