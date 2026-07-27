# Proposal: add-kicad-side-panel

Tracking: [#114](https://github.com/chouhanindustries/copperhead/issues/114) (Phase B). Builds on the Phase A context bridge (change add-kicad-ipc-bridge, merged into the same branch line).

## Why

Phase A gave the agent eyes into a running KiCad; the user still has to keep a terminal beside the editor. Phase B gives copperhead a home inside KiCad's own window: a dockable pane in pcbnew where the user types a change request, watches the run stream, and gets the verified/committed outcome, without leaving the board. KiCad's IPC plugins run out-of-process and cannot embed UI, so the pane must be in-process wx UI via the SWIG action-plugin system (KiCad 9/10); it therefore hosts a chat surface that drives copperhead headless over a local RPC rather than embedding the terminal REPL.

## What Changes

- New `copperhead serve`: a headless run surface speaking NDJSON (one JSON object per line) over stdio. Methods: `hello` (handshake: versions, repo, model), `run` (one gated agent run; streams `log` events, returns the outcome), and `check` (LLM-free verify). One run in flight at a time. There is deliberately no `cancel` method: the agent loop has no abort mechanism, so the panel's stop control kills and restarts the serve child, matching the REPL's Ctrl+C semantics. `serve` counts as an attended surface like the REPL and `do`: it constructs the Phase A KiCad bridge, so panel-launched runs get selection context and the reload prompt for free.
- New `plugins/kicad/` in this repo: a Python action plugin for KiCad 9/10 that docks a copperhead pane into the pcbnew frame via wx AUI. The pane has a request input, a scrolling run log, a status row (model, run state, outcome), and a stop button that terminates and restarts the serve child (the REPL Ctrl+C equivalent). It spawns `copperhead serve` in the project directory, forwards `KICAD_API_SOCKET`/`KICAD_API_TOKEN`, and talks NDJSON over the child's stdio. A missing copperhead CLI renders an install hint instead of failing.
- New PCM addon packaging: a build script assembles the Plugin and Content Manager zip (`metadata.json`, `plugins/`, `resources/icon.png`) so the panel installs through KiCad's own addon manager; CI can publish it as a release artifact.
- Known platform limit, documented rather than hidden: the SWIG plugin system is removed in KiCad 11 and the IPC plugin system has no UI embedding yet, so the panel targets KiCad 9/10; the KiCad 11 story is tracked in #114.

## Capabilities

### New Capabilities

- `copperhead-serve`: the headless NDJSON-over-stdio run surface: handshake, streamed run events, outcome reporting, single-flight, secret redaction on the wire.
- `kicad-side-panel`: the pcbnew pane: docking, request/response UI behavior, serve-process lifecycle (spawn, restart, missing-CLI hint), env forwarding, and the PCM packaging that ships it.

### Modified Capabilities

<!-- none: serve reuses the gated agent loop unchanged; check/sync/create isolation (AC-114.6) is untouched because serve is an attended surface like the REPL and do. -->

## Acceptance Criteria (AC-114B)

- **AC-114B.1 serve handshake**: `copperhead serve` started in a repo prints exactly one `hello` NDJSON object (protocol version, copperhead version, repo root, resolved model or null) and then waits; malformed input lines produce an `error` object, never a crash; an unresolvable model is not fatal (check works, runs get a `no-model` error).
- **AC-114B.2 streamed run**: a `run` request streams `log` events during the run and ends with exactly one `result` object carrying the run outcome (`success`/`refused`/`failure`), summary, and files touched; the underlying run is the same gated loop `do` uses (spec-gated in, verification-gated out).
- **AC-114B.3 single flight**: a `run` sent while a run is active is rejected with a `busy` error without disturbing the active run.
- **AC-114B.4 redaction**: strings matching the secret pattern (AC-4.1) are redacted in every NDJSON object serve emits.
- **AC-114B.5 panel structure**: the plugin registers as a pcbnew action plugin, docks an AUI pane titled "copperhead" into the pcbnew frame, and toggles visibility on repeated invocation; it never blocks the wx main thread on serve I/O (reads happen on a worker thread posting to the UI).
- **AC-114B.6 degraded start**: with no copperhead CLI on PATH (and none configured), the pane shows an install hint and no run controls; with a CLI present, the pane spawns `copperhead serve` in the open board's project directory and forwards `KICAD_API_SOCKET`/`KICAD_API_TOKEN` to it.
- **AC-114B.7 packaging**: the build script produces a PCM zip whose `metadata.json` validates against the PCM schema shape (identifier, name, description, version matching package.json, kicad version bounds "9.0"–"10.*"), and whose file layout installs the plugin under `plugins/`.
- **AC-114B.8 offline testability**: serve protocol behavior (AC-114B.1–B.4) and packaging (AC-114B.7) are covered by vitest with no KiCad and no LLM; panel behavior that requires a live pcbnew is exercised by a documented manual checklist, not CI.

## Impact

- New code: `src/commands/serve.ts` (protocol + command), `plugins/kicad/` (Python plugin: `__init__.py` action plugin registration, `panel.py` wx pane, `client.py` NDJSON child-process client), `scripts/build-pcm-addon.mjs`.
- Modified code: `src/cli.ts` (register `serve`), README + SPEC.md (surface docs), `.github/workflows` optionally later for the release artifact (not in this change's tasks if CI wiring is deferred).
- Dependencies: none new at runtime for Node; the plugin uses only the wxPython that ships inside KiCad's Python.
- Risks: SWIG removal in KiCad 11 (documented, tracked in #114); AUI docking quirks across platforms (pane falls back to floating if the frame lookup fails).
