# Findings report: end-to-end `copperhead create` run (issue #66)

Test bed: fresh repo seeded with `examples/medium/esp32-soil-sensor.md` as `brief.md`, driven with
`copperhead create --brief examples/medium/esp32-soil-sensor.md --model claude-code` (copperhead v0.7.0, kicad-cli 10.0.5, node v24.4.1, darwin-arm64).
Full log: `run1.log` (attached). Per-run transcripts: `.copperhead/runs/<ts>/` in the test bed.

Legend (per issue #66): severity is one of **BLOCKER / DEFECT / INEFFICIENCY / NOTE**; each finding carries
**Where / Symptom / Suggested / Status**; recommendations carry a **P0-P3** priority.

Quoting convention: log and doc excerpts are quoted verbatim in fenced blocks, except that em dashes
in the original output are normalized to a plain hyphen (`-`) to keep this file within the repo's
em-dash-free markdown convention. Line numbers refer to `run1.log`.

---

## F-1 NOTE: kicad-dependent tests fail instead of skipping when `kicad-cli` is absent

- **Where:** `test/bootstrap.test.ts`, `test/create-hardening.test.ts`, and other suites that reach `src/kicad/cli.ts` (`test/observability.test.ts`, `test/runmeta.test.ts`, `test/preflight.test.ts`, `test/budget-efficiency.test.ts`, `test/gating-sync.test.ts`).
- **Symptom:** on a fresh clone without KiCad installed, `npm test` reports 8 failures. Every failing test ultimately shells out to `kicad-cli` (for example `kicadLoadError` in `src/kicad/cli.ts`, which runs `await execa('kicad-cli', args, { reject: false })`). This contradicts CONTRIBUTING.md, which promises the offline suite runs anywhere:

  ```text
  CONTRIBUTING.md:19: Integration tests that call an LLM are skipped automatically unless an
  API key environment variable is present, so `npm test` is safe to run anywhere.
  ```

  The only conditional guards in the test tree are LLM-keyed (`describe.skipIf(!key)` in `test/agent-integration.test.ts`, `it.skipIf(sdkInstalled)` in `test/claude-code-provider.test.ts`); there is no `kicad-cli` presence guard anywhere in `test/`.
- **Suggested (P2):** add a `kicad-cli` presence probe (a cached `hasKicadCli()` helper) and gate the kicad-dependent suites with `describe.skipIf(!hasKicad)` plus a skip reason, mirroring the existing LLM-key pattern. Keep CI strict: CI installs KiCad, so a missing binary there should still fail loudly (for example a `COPPERHEAD_REQUIRE_KICAD=1` env flag set in CI that turns the skip into a failure).
- **Status:** open. Reproduced on a fresh clone; not yet fixed in this PR (fix planned alongside the E2E harness).

## F-2 NOTE: acceptance criteria cite `npm run lint`, but no `lint` script exists

- **Where:** issue #66 acceptance criteria ("`npm test` and `npm run lint` pass") vs `package.json` scripts.
- **Symptom:** `package.json` defines only `lint:md`:

  ```text
  "lint:md": "markdownlint-cli2 \"**/*.md\" ..."
  ```

  `npm run lint` exits with `npm error Missing script: "lint"`, so the acceptance criterion is not runnable as written.
- **Suggested (P3):** either add a `"lint": "npm run lint:md"` alias to `package.json`, or correct the docs and issue template to reference `npm run lint:md`.
- **Status:** open. Trivial; will include whichever direction the maintainer prefers.

## F-3 DEFECT: failed architecture attempt leaves a stage-labeled commit, so history shows two "stage: architecture" commits (one partial)

- **Where:** stage runner commit path (create pipeline stage commit + recovery supervisor retry), observed at run `2026-07-24T09-35-23-803Z` (attempt 1) and `2026-07-24T09-43-23-263Z` (attempt 2).
- **Symptom:** in attempt 1 the agent completed the proposal and validation gates, wrote CHANGELOG/DECISIONS entries, but never wrote the stage artifact `docs/SUBSYSTEMS.md`, then called `finish`. The run still committed, with the normal stage label:

  ```text
  run1.log:578  committed 64c26bf506 (0 file(s))
  run1.log:579  done · ERC not run · committed 64c26bf506 · 7m48s · 3 in / 32.6k out
  run1.log:580  stage architecture: the run finished but the stage completion contract is not met - no usable artifact was produced; asking the model whether to retry…
  run1.log:581  stage architecture: diagnosis → retry - The agent completed the proposal/validation gates but never actually wrote docs/SUBSYSTEMS.md before calling finish - a skipped step that clearer instructions should fix.
  run1.log:582  stage architecture: running (attempt 2/3)
  ```

  Attempt 2 succeeded (`run1.log:622: committed aefffc7331 (3 file(s))`). The recovery supervisor behaved well (detected the unmet contract, diagnosed, retried), but the failed attempt's commit was already in history, so the test bed now shows two identically labeled stage commits, one of which is the partial attempt:

  ```text
  $ git log --oneline
  3d39da9 copperhead: create pipeline stage: part-selection
  aefffc7 copperhead: create pipeline stage: architecture
  64c26bf copperhead: create pipeline stage: architecture
  5171828 copperhead: create pipeline stage: spec-seed
  da6f626 initial commit: esp32 soil sensor brief
  ```

  Classified as DEFECT rather than INEFFICIENCY because the commit is a false record: the pipeline's model is one commit per completed stage, and `64c26bf` asserts a completed architecture stage that the pipeline itself judged "contract not met". Anything that reads stage completion from commit subjects (bisecting, auditing, a future resume heuristic) can be misled. The pipeline outcome was correct only because the supervisor re-ran the stage.
- **Suggested (P2):** label partial or failed-attempt commits distinctly (for example `copperhead: create pipeline stage: architecture (attempt 1, contract unmet)`), or squash/amend the failed attempt into the successful retry so history keeps exactly one commit per completed stage.
- **Status:** open. Evidence preserved in the test bed history and `run1.log`.

---

## TODO: findings from stages 4-8 (run in progress)

The run is currently in stage 4 (schematic, run `2026-07-24T10-05-50-017Z`). Slots below are reserved for the remaining stage classes called out by issue #66; each will be filled only with log-grounded evidence, and recurrences of already-tracked issues will reference their issue numbers instead of duplicating.

- **TODO F-4 (stage 4, schematic): wedge behavior.** Prior manual runs wedged at this stage per issue #66. Watch: `verify_symbols` obligation flow (a finish-override on that obligation already appeared at stage 3, `run1.log:780`), ERC on the freshly scaffolded empty project, repair-cycle exhaustion.
- **TODO F-5 (stages 4-6): false-green gates.** Watch: ERC "clean" on a zero-symbol schematic (known prior class), DRC on an empty board, drift checker "vacuously clean" paths (`run1.log:274`, `run1.log:576`) once a real schematic exists.
- **TODO F-6 (any stage): session/turn limits.** Watch: turn cap (`turns <=40`) or provider session limit treated as a hard error vs graceful resume; long silent stretches already observed (9m30s with no tool result at `run1.log:820-841`).
- **TODO F-7 (whole run): temp/`.history/` growth and cache behavior.** Watch: disk buildup between attempts; also `0% cache hits` reported after every stage (`run1.log:281`, `run1.log:624`, `run1.log:813`), a candidate INEFFICIENCY if the llm-cache is written but never read during create.
- **TODO F-8 (stages 7-8, firmware and dev-plan): completion contract and final exit code.** Watch: final stage committed, process exits 0, `.copperhead/runs/*` summary written.

## F-4 BLOCKER: `copperhead check` preflight passes with zero KiCad symbol libraries installed, guaranteeing a stage 4 dead end

- **Where:** preflight (`copperhead check` and the create pipeline's startup banner) vs `src/kicad/symlib.ts` `symbolSearchDirs()`.
- **Symptom:** on a host where `kicad-cli` is on PATH but the stock symbol libraries are not at a known location (this machine: KiCad.app under `~/Applications`, so the hardcoded `/Applications/KiCad/...` default missed; `KICAD_SYMBOL_DIR` unset), `copperhead check` and the run banner report the environment as wired up. The run then proceeds through stages 1 to 3 (42m30s, 162.6k tokens) before stage 4 discovers there is no pin oracle. From the stage 4 attempt 1 summary (`.copperhead/runs/2026-07-24T10-05-50-017Z/summary.md`):

  ```text
  ... two direct verify_symbols calls both return 0 verified / 8 unverifiable, incl. Device:R and power:GND ...
  NO authoritative pin source exists in this environment.
  ```

- **Suggested (P1):** preflight should probe `symbolSearchDirs()` and report loudly (in `check` and in the create startup banner) when zero symbol libraries are found, with the same fix-it guidance style the kicad-cli-missing error already has (install location hints plus `KICAD_SYMBOL_DIR`). A three-second probe would have saved three stage attempts and roughly three hours.
- **Status:** open. Reproduced; environment corrected via `KICAD_SYMBOL_DIR` for the resumed run.

## F-5 INEFFICIENCY: the recovery supervisor retries a reasoned refusal as if it were a transient failure

- **Where:** create stage retry loop (`src/commands/create.ts` diagnosis path), stage 4 attempts 1 to 3.
- **Symptom:** attempt 1 ended in a deliberate, well-argued REFUSAL (missing pin oracle, see F-4) that named the exact unblock options ("install the KiCad stock symbol libraries ... OR add the six IC datasheet pin tables"). The supervisor still retried: attempt 2 burned the full 40-turn budget against the same wall (`.copperhead/runs/2026-07-24T11-09-43-347Z/summary.md`: "turn budget exhausted (40 turns, 14 files touched but unverified)"), and attempt 3 died on provider turn timeouts (`.copperhead/runs/2026-07-24T13-15-55-261Z/summary.md`: "provider turns timed out 4x (>600000ms each)"). Neither retry could have succeeded: the blocker was environmental, not behavioral.
- **Suggested (P2):** when a run ends in an explicit refusal that names an environmental precondition, the diagnosis step should classify it as abort-with-remediation (surface the model's own unblock instructions and stop), not retry. The refusal text is already structured enough to detect (the run summary carries it).
- **Status:** open. The refusal itself is the integrity gates working as designed and deserves credit; only the retry policy around it is wasteful.

## F-6 NOTE: turn watchdog fires per turn but the pipeline offers no mid-run signal that a stage is burning attempts against a fixed wall

- **Where:** observability of the create pipeline under failure (stage 4, attempts 1 to 3, roughly 3 hours wall time).
- **Symptom:** from the outside (a CI job or an operator tailing the log), the only distinguishable states during the 3-hour stage 4 arc were "running" and, ultimately, exit 1. The per-attempt outcomes (refused / turn-budget exhausted / 4x turn timeout) were visible only in per-run `summary.md` files after the fact. stdout is also block-buffered when redirected to a file, so the final attempts' output never reached the log on the crash.
- **Suggested (P3):** flush stage attempt outcomes to stdout as single unbuffered lines when each attempt ends (attempt number, outcome class, one-line reason), so an operator or CI harness can act after attempt 1 rather than after attempt 3.
- **Status:** open.

## F-7 BLOCKER: create mode never writes the protective .gitignore, so a failure-path clean can destroy the run evidence and the response cache

- **Where:** the create pipeline's repo bootstrap (no call into the `.gitignore` provisioning that `copperhead init` performs) vs the rollback path's `git clean`. The generated `.copperhead/README.md` text ("This directory is gitignored", `src/memory/scaffold.ts:135`) is false in create mode.
- **Symptom:** in a fresh `git init` test bed driven only by `copperhead create`, the repo's `.gitignore` contained only `.history/` (written by the KiCad history cap). After a stage 4 failure on the resumed run, the tree came back with the entire `.copperhead/` directory gone: all seven run transcript dirs, `report.json`/`REPORT.md`, the llm-cache (the recorded provider turns for six committed stages), and the config. The run's own log file (untracked) was deleted by the same clean. Total loss of the audit trail that `.copperhead/runs/` exists to preserve, and of the cache that makes retries cheap.
- **Suggested (P1):** create's bootstrap must write the same AC-4.3 `.gitignore` entries init writes (`.env`, `.copperhead/runs/`, plus the llm-cache) before the first stage runs; and the rollback clean should exclude `.copperhead/` wholesale rather than relying on ignore rules being present.
- **Status:** open. Reproduced at the cost of this run's evidence; the resumed run armors the test bed manually (gitignore committed up front, log written outside the repo, periodic state snapshots).
