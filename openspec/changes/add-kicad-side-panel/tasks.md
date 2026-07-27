# Tasks: add-kicad-side-panel

Status note: implemented; offline suite green (serve protocol, packaging). The
end-to-end smoke (plugin client.py driving the real built CLI: hello handshake,
streamed check, result) passed locally. Live pcbnew pane verification runs via
plugins/kicad/TESTING.md before release.

Implements AC-114B.1 through AC-114B.8 (proposal.md). Design decisions D1 through D6 in design.md.

## 1. copperhead serve

- [x] 1.1 Protocol module in `src/commands/serve.ts`: NDJSON framing, `hello`/`run`/`check` methods, `log` events, `result`/`error`/`busy` replies, EOF exit (D1)
- [x] 1.2 Wire `run` to the gated agent loop with an injected-runner seam for tests; construct the KiCad bridge as an attended surface (D2, AC-114B.2)
- [x] 1.3 Single-flight guard; no cancel method by design, stop = child termination (AC-114B.3)
- [x] 1.4 Redact secret patterns in every emitted object (AC-114B.4)
- [x] 1.5 Register `serve` in `src/cli.ts`

## 2. Serve tests (offline)

- [x] 2.1 Handshake, malformed input, unknown method, EOF exit (AC-114B.1)
- [x] 2.2 Streamed run: log events then exactly one result; failure outcome keeps serving (AC-114B.2)
- [x] 2.3 Busy rejection while a run is active (AC-114B.3)
- [x] 2.4 Redaction on the wire (AC-114B.4)

## 3. pcbnew side panel (plugins/kicad/)

- [x] 3.1 `client.py`: NDJSON child-process client (spawn in project dir, env forwarding, reader thread, restart-on-exit, CLI discovery PATH-then-config) (D3, D4)
- [x] 3.2 `panel.py`: wx pane (request input, run log, status row, stop button killing/restarting the child; wx.CallAfter marshalling; disabled-input single flight) (AC-114B.5)
- [x] 3.3 `__init__.py`: ActionPlugin registration, AUI dock with floating fallback, visibility toggle (AC-114B.5)
- [x] 3.4 Missing-CLI install hint state (AC-114B.6)
- [x] 3.5 `plugins/kicad/TESTING.md`: manual checklist covering AC-114B.5/B.6 on a live pcbnew

## 4. PCM packaging

- [x] 4.1 `scripts/build-pcm-addon.mjs`: assemble metadata.json (version from package.json, kicad bounds 9.0–10.*), plugins/, resources/icon.png; zip in PCM layout (D5, AC-114B.7)
- [x] 4.2 Placeholder copper fiducial icon under `plugins/kicad/resources/`
- [x] 4.3 Offline packaging test: run the script, unzip, assert layout and metadata (AC-114B.7, AC-114B.8)

## 5. Docs and spec sync

- [x] 5.1 SPEC.md: serve in the CLI surface section, panel as §2.8, AC-114B block in §9
- [x] 5.2 README: side-panel install (PCM zip) and serve usage notes
- [x] 5.3 Update issue #114 with Phase B implementation status
