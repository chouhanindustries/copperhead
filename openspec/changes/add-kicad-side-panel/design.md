# Design: add-kicad-side-panel

## Context

Phase A (add-kicad-ipc-bridge) gave the agent read-only context from a running KiCad. Phase B puts a copperhead surface inside pcbnew. Platform facts that shape everything: KiCad's IPC plugins run as separate processes and cannot embed UI; in-window UI means the SWIG action-plugin system, which exists in KiCad 9/10 and is removed in KiCad 11; KiCad ships its own Python with wxPython, and action plugins run on the wx main thread inside the pcbnew process. copperhead is a Node CLI, so the panel cannot call it in-process; it needs a child process and a wire protocol.

## Goals / Non-Goals

**Goals:**

- A headless run surface (`copperhead serve`) any embedder can drive: NDJSON over stdio, streamed run events, same gated loop as `do`.
- A dockable pcbnew pane (KiCad 9/10) for request-in, run-log-out, with the Phase A bridge active underneath.
- PCM packaging so installation is KiCad-native.
- Offline CI coverage for everything that does not require a live pcbnew.

**Non-Goals:**

- KiCad 11 support in this change (no in-process UI path exists there yet; tracked in #114).
- Schematic-editor panel (eeschema has no plugin system relevant here).
- Rich chat rendering (markdown, diffs) in the pane; v1 is a run log.
- Auth or remote transport for serve; it is local stdio only, spawned by its consumer.

## Decisions

### D1: Serve speaks NDJSON over stdio, spawned per panel session

One JSON object per line, both directions: requests `{id, method, params}`, streamed events `{id, event, data}`, terminal replies `{id, result}` or `{id, error}`. No cancel method: the agent loop cannot abort mid-turn, so stopping a run is the embedder killing the child (REPL Ctrl+C semantics), and pretending otherwise on the wire would be a lie. Chosen over: a Unix socket server (lifecycle and cleanup burden, no second consumer yet), JSON-RPC 2.0 framing (adds envelope ceremony without adding capability), and MCP (the panel is a first-party UI, not a foreign host; see issue #40 for the real MCP surface). stdio ties serve's lifetime to its consumer, which is exactly the panel's need, and NDJSON is trivially parseable from Python without dependencies.

### D2: Serve is an attended surface: it wires the Phase A bridge

`serve` constructs a `KicadBridge` exactly like the REPL and `do`, so panel-launched runs get selection injection and the reload prompt with zero panel-side work. The AC-114.6 isolation contract is unchanged: `check`/`sync`/`create` still never touch the socket; serve joins the attended allowlist. The panel forwards `KICAD_API_SOCKET`/`KICAD_API_TOKEN` from its own environment (set by KiCad for plugin processes), which Phase A's discovery already prefers.

### D3: The pane is a thin wx AUI client; all protocol logic lives in `client.py`

`__init__.py` registers the ActionPlugin and finds the pcbnew frame's AuiManager; `panel.py` is layout and event handlers; `client.py` owns the child process (spawn, NDJSON encode/decode, reader thread, restart). The reader thread never touches wx directly; it posts events via `wx.CallAfter` (AC-114B.5). If the AUI frame lookup fails (platform quirk), the pane opens floating rather than not at all. Python stays dependency-free beyond KiCad's bundled wx.

### D4: CLI discovery is configured-or-PATH, never bundled

The plugin looks for `copperhead` on PATH, then a user-set path stored in the plugin's own config file (KiCad's plugin settings path). Bundling Node inside a PCM zip is out: platform-specific binaries would bloat the addon and rot independently of npm releases. A missing CLI is a rendered install hint (AC-114B.6), keeping the addon installable before copperhead itself.

### D5: Packaging is a checked-in build script producing the PCM zip

`scripts/build-pcm-addon.mjs` assembles `metadata.json` (version read from package.json so they cannot drift), `plugins/` (the Python sources), and `resources/icon.png`, and zips them in the PCM-required layout. CI wiring to publish the zip on release is deliberately left out of this change's tasks; the script is the contract, the workflow is a follow-up chore.

### D6: Test split: protocol and packaging in vitest, pane by manual checklist

Serve is driven in-process by tests (injected runner seam like the REPL tests use), covering handshake, streaming, single-flight, redaction, malformed input. The packaging test runs the build script and inspects the zip. The wx pane cannot run headless in CI without a KiCad; a manual checklist in `plugins/kicad/TESTING.md` covers dock/toggle/run/missing-CLI against a real pcbnew, mirroring how the live IPC suite gates on a real KiCad.

## Risks / Trade-offs

- [SWIG plugin system removed in KiCad 11] → scoped to 9/10 explicitly in metadata's kicad version bounds; #114 tracks the 11+ story (UI embedding over IPC upstream, or a toolbar action falling back to the terminal REPL).
- [AUI internals differ across KiCad builds/platforms] → frame lookup is defensive with a floating-frame fallback; the manual checklist covers Linux/Windows/macOS separately.
- [Serve consumer dies without cleanup] → serve exits when stdin closes (EOF), so an orphaned child cannot outlive the panel; a run in flight is abandoned to its normal rollback path.
- [Two processes disagree about the repo] → the panel spawns serve in the open board's project directory and the `hello` reply echoes the resolved repo root; the pane displays it so a mismatch is visible, not silent.
- [Panel UI grows scope (markdown, approval prompts)] → v1 pins scope to request/log/outcome + stop; interactive approval (`--interactive`) is explicitly not exposed in the panel yet.

## Open Questions

- Icon: ship a placeholder copper fiducial PNG now; proper artwork later.
- Whether `serve` should also expose `sync`; deferred until a consumer needs it.
