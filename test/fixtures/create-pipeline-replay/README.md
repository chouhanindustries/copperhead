# Create-pipeline replay fixture

This directory is the output of the opt-in end-to-end harness in
`test/create-pipeline-replay.test.ts`. It is intentionally empty of recorded
turns in the source checkout: a fixture must be made by a real `runCreate`
execution, and no synthetic provider response is accepted.

Run the recording pass only when a real provider session is available and the
machine has the KiCad and OpenSpec versions that replay will use. Run these
commands from the repository root with `kicad-cli`, `openspec`, and the selected
provider executable on `PATH`:

```sh
COPPERHEAD_E2E_RECORD=1 \
COPPERHEAD_E2E_MODEL=codex:gpt-5.6-sol \
npx vitest run test/create-pipeline-replay.test.ts --no-file-parallelism
```

The test creates a fresh git repository, keeps the real
`examples/simple/usb-c-breakout-verified-parts.md` brief outside that repository, invokes
`runCreate` with the selected provider, and writes these generated inputs:

- `usb-c-breakout.md`: the external brief, with its SHA-256 in the manifest;
- `config.json`: the initial cache-key/config seed used for both passes (it
  allows 20 repair cycles without relaxing ERC/DRC and disables uncached
  automatic stage diagnosis, so a failed stage stops loudly);
- `llm-cache/*.json`: the actual responses returned by the provider;
- `manifest.json`: model, per-stage deterministic clocks, KiCad/OpenSpec
  versions, initial/final tree digests, and every cache-entry checksum. The
  final tree digest canonicalizes only KiCad exporter creation-date metadata in
  SVG/Gerber/Excellon/STEP text; drawn content, net data, and geometry remain
  byte-sensitive.

Replay deliberately removes API keys in the shell and enables the strict
cache-only path. The harness copies the recorded cache into two different fresh
temporary repository paths, then calls the production `runCreate` path twice:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  COPPERHEAD_LLM_CACHE_ONLY=1 \
  npx vitest run test/create-pipeline-replay.test.ts --no-file-parallelism
```

Both replays require all eight stage results and summaries, one distinct git
commit for each stage, a non-empty `docs/DEVPLAN.md`, firmware and fabrication
files, a non-empty schematic, and independent real ERC, DRC, and `runCheck`
success. They also require every report turn to be a cache hit with zero input
and output tokens, and the replay log hit count to equal the report total.
Missing or corrupt cache entries therefore fail through the strict
cache-only provider rather than silently reaching a live provider.

The test changes only `Date` and `Date.now` while a run is active. Each stage
has a distinct timestamp so its transcript summary has its own directory; real
timers remain enabled for provider/watchdog behavior. Temporary repositories
and external briefs use prefixes outside Copperhead's stale-temp sweep.

The parent test runs the record/replay body in a detached child Vitest process.
Its deadline defaults to two hours for record and fifteen minutes for replay;
override it with `COPPERHEAD_E2E_TIMEOUT_MS`. At the deadline the parent sends
`SIGTERM`, escalates to `SIGKILL`, and removes the child scratch root, so a
provider CLI or KiCad descendant in that process group cannot keep the test
alive. The child also has the matching Vitest timeout as a second fail-fast
bound. Set `COPPERHEAD_E2E_KEEP_TMP=1` to retain temporary repositories for
inspection after a normal run; a killed process may leave them until the parent
cleanup completes. On POSIX the parent checks process-group liveness and reports
termination only after the OS returns `ESRCH`; an unknown liveness result fails
as unconfirmed. Windows uses `taskkill /T /F`, but the harness does not claim
that its process-group termination was confirmed. No live record or replay
result is claimed until the generated fixture has passed on the target
KiCad/OpenSpec versions.

The process-group deadline behavior has a separate opt-in probe. It starts a
leader that exits with code 0 on `SIGTERM` while its descendant ignores that
signal, then requires the watchdog to escalate and confirm that the whole group
is gone. On POSIX it also checks the descendant PID reported over the child
pipe; Windows exercises the deadline rejection path without a liveness claim.

```sh
COPPERHEAD_E2E_WATCHDOG_TEST=1 npx vitest run test/create-pipeline-replay.test.ts
```
