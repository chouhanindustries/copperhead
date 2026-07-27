# copperhead side panel: manual test checklist

Pane behavior needs a live pcbnew, so it is verified by hand (AC-114B.8),
the same way the Phase A live IPC suite gates on a real KiCad. Run this
checklist on each platform before a release that touches `plugins/kicad/`.

The pane's decision logic and the serve child client are NOT manual-only:
`plugins/kicad/tests/` covers them with stdlib unittest (discovery order,
restart budget, project-dir fallback reasons, project switching, slash
handling, NDJSON framing, stderr capture, kill semantics), and the vitest
suite runs it via `test/kicad-panel-py.test.ts`. This checklist is only for
what genuinely needs wx and a live board.

Setup: KiCad 9 or 10, API server enabled (Preferences > Plugins > "Enable
KiCad API"), a board open, `copperhead` on PATH, the addon installed from
the PCM zip (`node scripts/build-pcm-addon.mjs`, then Plugin and Content
Manager > Install from File).

## Dock and toggle (AC-114B.5)

- [ ] The copperhead toolbar button appears in pcbnew (copper fiducial icon).
- [ ] First click docks a pane titled "copperhead" on the right.
- [ ] Second click hides it; third shows it again, same position.
- [ ] pcbnew stays responsive while the pane is open (pan/zoom the board).
- [ ] On a platform where docking fails, the pane opens floating and works.

## Serve lifecycle (AC-114B.6)

- [ ] With `copperhead` on PATH: the status row shows the model and the open
      board's project directory (from the `hello` handshake).
- [ ] With the CLI renamed away and no config: the pane shows the install
      hint, the input is disabled, and nothing errors.
- [ ] Writing `{"cli": "/path/to/copperhead"}` to the path named in the hint
      and reopening the pane connects through the configured binary.
- [ ] Killing the serve process externally shows the restart notice and the
      pane reconnects.

## Run interaction (AC-114B.5)

- [ ] Submitting a request disables the input, streams log lines live, and
      re-enables the input when the outcome line appears.
- [ ] The outcome is visibly distinguished (green success, red failure).
- [ ] A second submit attempt during a run is impossible (input disabled).
- [ ] Stop kills the run; the restart notice appears; the next request works.
- [ ] With items selected on the board, a request like "what did I select"
      reflects the selection (Phase A bridge active under serve).
- [ ] After a committed run touching the open board, the log shows the
      reload prompt naming the file (AC-114.4).

## Packaging (AC-114B.7 spot check)

- [ ] The PCM zip installs and uninstalls cleanly through the Plugin and
      Content Manager, no manual file placement.
