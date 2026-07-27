# Tasks: add-kicad-ipc-bridge

Implements AC-114.1 through AC-114.7 (proposal.md). Design decisions D1 through D7 in design.md.

Status note: all tasks are implemented, the offline suite is green, and the live suite has passed against a real KiCad 10.0.4 (native install, API server enabled in preferences, fixture board open in pcbnew), which also wrote the drift-capture fixture. Note for operators: KiCad ships with the API server disabled; enable it under Preferences > Plugins ("Enable KiCad API") or the bridge stays in the disconnected state.

## 1. Protocol foundation

- [x] 1.1 Vendor KiCad's published `.proto` files under `src/kicad/proto/`, pinned to one release tag recorded in `src/kicad/proto/VERSION` (D1) — pinned to kicad-10.0.5
- [x] 1.2 Add `protobufjs` dependency and a loader that compiles the vendored protos at runtime (no codegen build step) — `loadProtoRoot()` in `src/kicad/ipc.ts`; `scripts/copy-protos.mjs` mirrors protos into dist at build
- [x] 1.3 Implement the envelope protocol transport in `src/kicad/ipc.ts` over Node `net` (Unix socket path and Windows named pipe behind one interface) (D1) — hand-built nng REQ0: SP handshake, in-band frames, request-id echo

## 2. Connection lifecycle

- [x] 2.1 Implement discovery: `KICAD_API_SOCKET`/`KICAD_API_TOKEN` env vars first, then the platform's well-known socket path (D2) — `discoverKicadAddress()`
- [x] 2.2 Non-blocking startup connect with a 250 ms budget, plus slow-interval re-probe while disconnected (D2, AC-114.1)
- [x] 2.3 Soft-failure handling: map every connect/decode/timeout/version error to the disconnected state; log to transcript, never throw into a run (D6, AC-114.5)
- [x] 2.4 API version negotiation at connect; feature-detect optional calls (D7 risk mitigation) — GetVersion doubles as the handshake sanity check; AS_UNHANDLED on the schematic doctype is treated as feature absence. Finding: the 10.0.5 API has no refresh-from-disk or dirty-state call, which resolved D5 to prompt-only (see design.md)

## 3. Fake IPC server test fixture

- [x] 3.1 Build a fake IPC server speaking the envelope protocol over a temp-dir socket (D7) — `test/kicad-ipc-fake.ts`
- [x] 3.2 Frame fixtures (reworded with D7): the fake server builds frames at runtime from the same vendored protos; the live suite (6.2) writes `test/fixtures/kicad-ipc/live-capture.json` from a real session for drift comparison — captured from KiCad 10.0.4 and checked in
- [x] 3.3 Offline tests for connection lifecycle: connect, absent socket, late server start, mid-session disconnect, malformed handshake, request timeout (AC-114.1, AC-114.5, AC-114.7) — `test/kicad-ipc.test.ts`

## 4. Agent integration

- [x] 4.1 Add `ctx.kicad` connection handle to `RunContext`; wire construction in the REPL and `do` paths only (D6, AC-114.6)
- [x] 4.2 Implement `get_kicad_selection` and `get_open_documents` tool handlers in `src/agent/tools.ts`, gated in `availableTools(ctx)` on a live connection (D3, AC-114.2)
- [x] 4.3 Mid-run disconnect: in-flight tool call returns a soft error string; tools drop out of the next turn's list (D3, AC-114.5)
- [x] 4.4 Selection snapshot at run start, injected as a labeled possibly-irrelevant context block with references, values, and nets; empty selection injects nothing (D4, AC-114.3) — `kicad-selection` transcript event records it
- [x] 4.5 Offline tests: tool list contents connected vs disconnected, selection injection present/absent (AC-114.2, AC-114.3) — `test/kicad-agent.test.ts`

## 5. REPL surface

- [x] 5.1 Observability-row `kicad` indicator with connected/disconnected states and live updates on reconnect (AC-114.1) — meta row segment (`kicad 10.0.5` / `kicad off`), `/status` row, and a prompt refresh hook in `src/util/live-prompt.ts`
- [x] 5.2 Post-run reload prompt: after a committed run touching a board open in the connected KiCad, print the prompt naming the file; never reload automatically (D5, AC-114.4) — `kicadReloadNote()` surfaced from the loop so `do` and the REPL share it; `kicad-reload-prompt` transcript event
- [x] 5.3 Offline tests for the reload prompt paths (open board, schematic-only, other board, no bridge, bridge failure) (AC-114.4)

## 6. Isolation and verification

- [x] 6.1 Test that `check`, `sync` verify, and a bridge-less agent loop produce zero connection attempts against a listening fake server, even with `KICAD_API_SOCKET` pointing at it (AC-114.6)
- [x] 6.2 Live test suite gated by `COPPERHEAD_TEST_KICAD_IPC=1`, following the existing `COPPERHEAD_TEST_CODEX=1` pattern (D7, AC-114.7) — `test/kicad-live.test.ts`; passed against a real KiCad 10.0.4 (version negotiation, open documents, selection)
- [x] 6.3 Full offline suite green with no KiCad running (AC-114.7) — 453 passed, 18 provider-gated skips

## 7. Docs and spec sync

- [x] 7.1 Add the bridge and AC-114 to SPEC.md (surface description §2.7 plus acceptance criteria section)
- [x] 7.2 Document KiCad-connection behavior in the `.copperhead/README.md` template (`src/memory/scaffold.ts`) and the user-facing README
- [x] 7.3 CHANGELOG conventions: resolved as not needed; the transcript already records `kicad-selection` and `kicad-reload-prompt` events, and run summaries gain nothing from repeating them
