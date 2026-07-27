# Design: add-kicad-ipc-bridge

## Context

KiCad 9+ ships an IPC API: protobuf messages in an envelope protocol over a Unix domain socket (named pipe on Windows). Official bindings exist only for Python (`kicad-python`); the API covers the PCB editor only, and the schematic editor has no API in KiCad 9/10/11. KiCad sets `KICAD_API_SOCKET`/`KICAD_API_TOKEN` env vars for plugins it launches, and external clients can connect to the well-known socket when the user enables the API server in preferences.

copperhead's two invariants (SPEC.md §1.3) constrain the design: mutations happen only through anchored file edits (spec-gated in) and are done only when kicad-cli verification passes (verification-gated out). The bridge must add context without creating a second mutation path. `check`/`verify` must stay LLM-free and network-free, and must not grow a dependency on a running KiCad.

Current code anchors: `availableTools(ctx)`/`dispatchTool` in `src/agent/tools.ts` build the tool list per run context; the REPL (`src/commands/repl.ts`) owns startup and the dock, and `src/agent/dock-renderer.ts` paints the observability row.

## Goals / Non-Goals

**Goals:**

- A Node IPC client (`src/kicad/ipc.ts`) that connects opportunistically to a running KiCad and degrades to a no-op when there is none.
- Live editor context for the agent: open documents, current selection, injected at turn start and available via read-only tools.
- A visible connection indicator in the REPL observability row.
- A post-run reload prompt when a verified run modified a board open in the connected KiCad.
- Offline-testable: the full behavior is exercisable against a fake IPC server; live tests are opt-in.

**Non-Goals:**

- Mutating the board through IPC commits (Phase C of #114; needs its own change and a verification-gating story).
- Schematic-editor context (KiCad exposes no API for it yet).
- The in-KiCad side panel (Phase B of #114): a dockable pane inside pcbnew hosting a chat UI that drives copperhead headless over local RPC. This change deliberately builds the IPC client and context tools as a library surface that panel can reuse, but ships no panel UI.
- Any bridge involvement in `check`/`verify` or the pre-commit hook.

## Decisions

### D1: protobufjs over vendored .proto files, not a Python sidecar

The official bindings are Python only. Options: (a) spawn `kicad-python` in a sidecar process and bridge over stdio, (b) vendor KiCad's published `.proto` files and decode with `protobufjs` at runtime. Choose (b): copperhead is a Node CLI with no Python dependency today and adding one for read-only context is disproportionate; `protobufjs` loads `.proto` files at runtime, so there is no codegen step in the build. The vendored protos are pinned to a KiCad release tag and recorded in `src/kicad/proto/VERSION`.

### D2: Discovery order: env vars, then well-known socket

Connect using `KICAD_API_SOCKET`/`KICAD_API_TOKEN` when present (this makes the client forward-compatible with the Phase B launcher, which forwards exactly these), otherwise probe the platform's well-known socket path. Connection attempts run in the background with a short timeout (250 ms budget at startup) so REPL startup latency is unaffected. The client re-probes on a slow interval so starting KiCad after the REPL still connects.

### D3: Connection-gated tools, structurally absent

`get_kicad_selection` and `get_open_documents` are added to `availableTools(ctx)` only while `ctx.kicad` holds a live connection, mirroring the spec-gating pattern: when KiCad is not connected the tools do not exist, rather than existing and erroring. This keeps the agent from wasting turns probing a dead bridge and keeps transcripts clean. A mid-run disconnect makes an in-flight call return a soft error string (dispatch already returns tool errors as strings) and removes the tools from subsequent turns.

### D4: Selection injected at turn start, snapshot semantics

At the start of each user turn the REPL snapshots the current selection and injects it as a clearly labeled context block ("the user currently has these items selected in KiCad; this may or may not be relevant"), analogous to `ide_selection` in Claude Code's VS Code extension. Snapshot rather than live query keeps the prompt stable within a turn; the `get_kicad_selection` tool exists for the agent to re-query when the user says "now this one". Empty selection injects nothing.

### D5: Reload is prompted, never forced

After a verified run whose file writes touched a board open in the connected KiCad, the run log prints a reload prompt naming the file (surfaced by the loop, so `do` and the REPL share one implementation). Implementation finding that hardened this decision: the pinned API (KiCad 10.0.5 protos) exposes no reload-from-disk call and no dirty-state query. `RefreshEditor` only repaints the in-memory model and `RevertDocument` would discard unsaved edits, so there is no safe automatic action at all; the prompt is the whole behavior.

### D6: All bridge failures are soft

Every IPC failure (connect, decode, timeout, version mismatch) degrades to "not connected": logged to the transcript, surfaced as a muted observability-row state, never fatal to a run and never a reason to fail verification. The bridge is wired into the REPL and `do` paths only; `check`/`sync`/`create` never construct a client.

### D7: Offline tests against a fake IPC server, live tests opt-in

A test fixture (`test/kicad-ipc-fake.ts`) implements the full wire protocol (SP handshake, in-band frames, request-id echo, ApiRequest/ApiResponse envelope) over a temp-dir socket, building its frames at runtime from the same vendored protos the client uses. All scenario coverage runs offline in vitest. A live suite gated by `COPPERHEAD_TEST_KICAD_IPC=1` (matching the existing `COPPERHEAD_TEST_CODEX=1` pattern) exercises a real KiCad instance for release verification and writes a capture fixture (`test/fixtures/kicad-ipc/live-capture.json`) for drift comparison; re-record it when bumping the pinned proto tag. Because both offline ends share the proto definitions, the live suite, not the fake server, is what catches real-KiCad drift.

## Risks / Trade-offs

- [KiCad API surface churn across 9/10/11] → pin vendored protos to one release tag, negotiate/record the API version at connect, feature-detect optional calls (refresh) instead of version-sniffing.
- [Windows named-pipe transport differs from Unix sockets] → isolate transport behind one interface in `ipc.ts`; Node's `net` module handles both path styles.
- [Recorded frames drift from real KiCad behavior] → the opt-in live suite exists precisely to catch this before releases; re-record frames when bumping the pinned proto tag.
- [Selection snapshot can be stale by the time the agent acts] → the injected block states when it was captured, and the tool allows re-query; staleness costs at most one clarifying turn.
- [Socket probing on every REPL start] → single non-blocking attempt with a hard timeout, then slow-interval re-probe; measured cost is one failed connect syscall when KiCad is absent.

## Open Questions (resolved during implementation)

- Proto pin: `kicad-10.0.5` (newest stable at implementation time), recorded in `src/kicad/proto/VERSION`. The tag exposes no refresh-from-disk or document-dirty calls, which resolved D5 to prompt-only.
- Selection payload: references, values, and nets are injected; positions/layers stay out of the prompt (available later via the tool if a real need appears).
