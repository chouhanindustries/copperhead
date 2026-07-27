# Proposal: add-kicad-ipc-bridge

Tracking: [#114](https://github.com/chouhanindustries/copperhead/issues/114) (Phase A)

## Why

The REPL is blind to the KiCad session the user is looking at: the agent cannot see which documents are open or what the user has selected, so prompts like "move this decoupling cap closer" have no referent. KiCad 9+ exposes an IPC API (protobuf over a Unix socket / named pipe) into the running editor, which lets copperhead pull live editor context the same way Claude Code's VS Code extension reads the active selection. This is the smallest, invariant-preserving slice of KiCad integration: context flows in, all mutations still go out through file edits gated by kicad-cli verification.

## What Changes

- New `src/kicad/ipc.ts`: a Node client for KiCad's IPC API, speaking the protobuf envelope protocol over the well-known socket. Connection is opportunistic: if no KiCad is running (or the API server is disabled, or the KiCad version predates the API), copperhead behaves exactly as today.
- REPL startup detects a running KiCad instance and reports it in the observability row (for example `kicad: pcbnew board.kicad_pcb`); disconnects and reconnects update the row live.
- Two new read-only agent tools, present only while a KiCad connection is up: `get_kicad_selection` (selected board items with references, nets, positions) and `get_open_documents` (documents open in the connected instance).
- The user's current KiCad selection is injected into the agent's context at turn start, analogous to `ide_selection` in the VS Code extension.
- After a verified run that modified a board file open in the connected KiCad, the run log prints a reload prompt naming the file. Nothing is reloaded automatically: the pinned API exposes neither a reload-from-disk call nor a dirty-state query, so any forced action could discard unsaved editor work.
- No new mutation path: `edit_file`/`write_file` remain the only way changes reach disk, and ERC/DRC gating is unchanged. **Not** included: IPC commits into KiCad's undo stack, schematic-editor API support (KiCad does not expose one yet), and the in-KiCad side panel (Phase B of #114: a dockable pane inside pcbnew hosting a chat UI that drives copperhead headless; this change builds the context bridge that panel will reuse).

## Acceptance Criteria (AC-114)

Binary, in SPEC.md style; the `kicad-ipc-bridge` delta spec scenarios map 1:1 onto these.

- **AC-114.1 Detect and degrade**: starting the REPL with KiCad running and its API server enabled shows a connected `kicad:` state in the observability row within 5 seconds; starting it with no KiCad (or the API disabled) shows the disconnected state, adds no measurable startup delay, and every other behavior is byte-identical to today.
- **AC-114.2 Structural tool gating**: while connected, the agent's tool list contains `get_kicad_selection` and `get_open_documents`; while disconnected, neither name appears in the tool list (verifiable in the run transcript), as opposed to being present and erroring.
- **AC-114.3 Selection injection**: with items selected in pcbnew, the next turn's context contains a labeled selection block with their references and nets; with nothing selected, no block is injected.
- **AC-114.4 Reload prompt, never forced**: after a committed run that modified a board file open in the connected KiCad, the run log prints a reload prompt naming that file. Nothing is reloaded automatically (implementation finding: the KiCad 10.0.5 API exposes neither a reload-from-disk call nor a dirty-state query, so a forced action could discard unsaved editor work).
- **AC-114.5 Soft failure**: killing KiCad mid-run turns an in-flight bridge tool call into a soft error string, the run continues to a normal verdict, and the tools are absent from subsequent turns.
- **AC-114.6 Command isolation**: `check`, `sync`, and `create` never open the IPC socket (a fake IPC server observing the socket path records zero connection attempts across their test runs).
- **AC-114.7 Offline testability**: the full scenario suite passes with no KiCad installed, against the fake IPC server; live tests run only under `COPPERHEAD_TEST_KICAD_IPC=1`.

## Capabilities

### New Capabilities

- `kicad-ipc-bridge`: connection lifecycle to a running KiCad instance (detect, degrade, reconnect), the read-only context tools and their gating, selection injection into the prompt, the observability-row indicator, and the post-run reload prompt.

### Modified Capabilities

<!-- none: the new tools are read-only and additive, so the spec-gating invariant (edit tools absent until a proposal validates) and the verification-gating invariant are untouched. Existing capability requirements do not change. -->

## Impact

- New code: `src/kicad/ipc.ts` (IPC client), generated/vendored protobuf definitions from KiCad's published `.proto` files.
- Modified code: `src/agent/tools.ts` (`availableTools`/`dispatchTool` gain the two connection-gated tools), `src/agent/loop.ts` or prompt assembly (selection context injection), `src/commands/repl.ts` and `src/agent/dock-renderer.ts` (observability row, reload prompt).
- Dependencies: `protobufjs` (runtime protobuf decoding; no codegen toolchain required at install time).
- Systems: talks only to a local KiCad socket; no network access, so the `check`/`verify` LLM-free and network-free contract is unaffected (the bridge is REPL/`do`-side only).
- Docs: SPEC.md gains the bridge as a Phase 1.5 surface; `.copperhead/README.md` documents the KiCad-connection behavior.
