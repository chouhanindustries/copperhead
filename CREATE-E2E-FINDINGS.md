# Create pipeline end-to-end findings

Date: 2026-07-24

Environment:

- Copperhead 0.7.0 at base commit `887346b`
- Node.js 24.3.0 on macOS arm64
- KiCad CLI 9.0.9
- Codex saved-login provider
- Initial smoke brief: `examples/simple/usb-c-breakout.md`
- Acceptance brief: `examples/medium/esp32-soil-sensor.md`

The smoke run was used to verify the toolchain and isolate the first pipeline
blocker. The live acceptance run uses the requested medium-complexity brief.
Run identifiers below map directly to the ignored
`.copperhead/runs/<run-id>/transcript.jsonl` and `summary.md` artifacts.

## Finding 1: Improving ERC checks exhausted the repair budget

- **Kind / Priority:** BLOCKER / P0
- **Where:** `src/agent/tools.ts`, `run_erc` and `run_drc`;
  runs `2026-07-24T09-25-27-347Z` and
  `2026-07-24T09-32-49-929Z`
- **Symptom:** Stage 4 rolled back twice with
  `repair cycles exhausted (5)` while incremental construction was reducing
  ERC violations. The first run reported the sequence
  `10, 5, 7, 6, 5, 6`; the retry later reduced `14` violations to `10`.
  Every failing check incremented one global counter, including the first
  baseline and four checks that proved progress.
- **Suggested:** Retain the previous violation count independently for ERC and
  DRC. Count only consecutive equal-or-worse reports against
  `maxRepairCycles`; reset the streak when a report improves or becomes clean.
- **Status:** Fixed. `trackRepairProgress` implements the bounded,
  progress-aware counter. `test/repair-progress.test.ts` replays the exact
  observed sequence and proves truly stagnant checks still exhaust the
  five-cycle budget. Replay run `2026-07-24T09-45-47-527Z` passed the formerly
  fatal sequence, reached clean ERC, satisfied drift, committed stage 4 as
  `d980708`, and reported a non-improving high-water mark of 3/5.

## Finding 2: Retry guidance described state that rollback had removed

- **Kind / Priority:** DEFECT / P1
- **Where:** `src/commands/create.ts`, recovery guidance assembled after a
  failed stage; retry run `2026-07-24T09-32-49-929Z`
- **Symptom:** The first attempt was stashed and restored to its pre-run
  snapshot. The retry nevertheless began with guidance to repair "the six
  current ERC findings." It was actually running against a newly scaffolded,
  empty schematic, so the guidance's claimed current state was false.
- **Suggested:** Tell the recovery diagnosis whether rollback occurred and
  provide the post-restore artifact state. Do not carry current-file claims
  from a failed transcript into a clean retry.
- **Status:** Open recommendation. It did not prevent deterministic replay or
  the source fix, so changing recovery semantics was kept out of the minimal
  blocker patch.

## Finding 3: Valid mid-wire labels were invisible to drift checking

- **Kind / Priority:** BLOCKER / P0
- **Where:** `src/kicad/sexp.ts`, `pinNets` and `listNets`; smoke replay run
  `2026-07-24T09-45-47-527Z`
- **Symptom:** KiCad ERC reached clean with all eight symbols present, but
  `check_drift` reported connected J1 ground pins as `NC`. The parser unioned
  only serialized wire endpoints, while KiCad legally places labels and
  T-junction endpoints anywhere on a segment. It also treated the ERC-only
  `power:PWR_FLAG` symbol's value as the net name, causing `PWR_FLAG` to
  override labels on otherwise valid nets.
- **Suggested:** Join explicit pins, labels, and wire endpoints that lie on a
  wire segment before resolving group names. Exclude `power:PWR_FLAG` from
  net-naming power symbols.
- **Status:** Fixed. `pinNets` now performs segment-aware unions and
  `namesPowerNet` excludes `PWR_FLAG`. The regression fixture places a 3V3
  label at the midpoint of a wire and a flag at its endpoint, then asserts the
  connected MCU pin remains on `3V3`.

## Finding 4: Stage transcripts can expand by an order of magnitude

- **Kind / Priority:** INEFFICIENCY / P2
- **Where:** run summaries for `2026-07-24T09-25-27-347Z` and
  `2026-07-24T09-32-49-929Z`
- **Symptom:** Seven schematic turns consumed 1,113,480 input tokens and
  127,001 output tokens; the ten-turn retry consumed 2,661,331 input tokens
  and 103,435 output tokens. The entire prior conversation and large KiCad
  edits are repeatedly presented to the provider.
- **Suggested:** Summarize superseded tool results and large file bodies after
  each verified checkpoint, while preserving hashes and the latest canonical
  content. Add a per-stage context-growth metric to the existing report.
- **Status:** Open recommendation. The response cache avoids paying twice for
  identical turns, but it does not reduce context growth on new turns.

## Finding 5: A mounted KiCad application is not enough for symbol validation

- **Kind / Priority:** NOTE / P2
- **Where:** `verify_symbols` results in the stage-4 transcripts
- **Symptom:** ERC ran successfully through KiCad 9.0.9, but every symbol was
  reported as `unverifiable (library not installed)`. The application bundle
  supplied `kicad-cli`; canonical symbol tables were not present in the user
  data locations searched by the validator.
- **Suggested:** Extend `copperhead check` with a distinct symbol-library
  readiness result and document the supported library path override. A usable
  CLI and a usable canonical symbol library should be reported separately.
- **Status:** Environment limitation recorded. ERC/DRC evidence remains valid;
  canonical symbol verification is explicitly not claimed for this setup.

## Finding 6: The bounty's documented lint command did not exist

- **Kind / Priority:** DEFECT / P2
- **Where:** `package.json` scripts versus issue 66 acceptance criterion
  "`npm test` and `npm run lint` pass"
- **Symptom:** The repository exposed `lint:md` and `typecheck`, but
  `npm run lint` exited with a missing-script error. Direct Markdown linting
  also traversed gitignored `manual-tests/runs/` sandboxes, so generated
  changelog headings could fail an otherwise clean source tree.
- **Suggested:** Provide the documented aggregate command so contributors and
  CI can run the acceptance criterion literally.
- **Status:** Fixed. `npm run lint` now runs typechecking followed by Markdown
  linting, and the existing sandbox directory is excluded like other generated
  run artifacts.

## Automated regression coverage

`test/create-e2e.test.ts` now runs the production `runCreate` and
`runAgentLoop` implementations without mocking either function or any stage
completion contract. A recorded provider supplies deterministic model turns;
the real tool dispatcher, OpenSpec lock, KiCad load probes, ERC/DRC, drift
gates, git commits, stage contracts, and final `copperhead check` all run.

The success case first warms `.copperhead/llm-cache/`, resets its disposable
git repository to the exact pre-run commit, and runs the same eight-stage
pipeline again with an inner provider that throws on every call. The replay
passes all eight stages and the final check with 16/16 turns served from the
on-disk cache and zero inner-provider calls.

The complete warm/replay console log and generated
`.copperhead/runs/REPORT.md` are committed at
`pipeline-run-logs/06-deterministic-8-stage-replay.log`.

The negative cases prove the same production path goes red when:

1. an empty scaffold reports clean ERC but has no symbols;
2. a schematic stage repeats a non-improving ERC result until the five-cycle
   repair budget is exhausted; and
3. the recorded run has no final-stage response, so `DEVPLAN.md` is never
   produced and the pipeline never reports completion.

The focused repair test and the orchestrator test run in the default offline
test suite.

## Live medium-run status

The medium brief progressed through stages 1–3 and exercised the real stage-4
edit/ERC loop. The latest recovered schematic is KiCad-loadable and independently
ERC-clean. The run did not reach stages 5–8: the saved-login Codex provider
reached its account usage ceiling after 46 turns
(`2026-07-24T20-54-09-269Z`; 24m39s), and Copperhead preserved the work and
reported `session-limit` with a resumable command. A second authenticated
provider was checked, but its organization has disabled subscription access for
Claude Code. This report therefore does not claim a clean live medium run; the
green eight-stage evidence above is the deterministic production-loop replay.
