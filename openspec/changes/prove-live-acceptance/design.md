# prove-live-acceptance: Design

## Context

The AC-3.x integration tests exist and are key-gated; `demo-runs/` already exists in the repo for ad hoc evidence; every run writes redacted transcripts. What is missing is the machinery that makes evidence continuous: scheduled execution, promotion of passing artifacts, a reproducible benchmark, and removal of hand-maintained claims. Both provider keys are assumed available as repo secrets (Anthropic parity, AC-3.10, becomes observable the day the key lands).

## Goals / Non-Goals

**Goals:**

- A reader can verify every maturity claim by clicking a badge, opening a transcript, or running one script.
- Claims in the README cannot silently drift from CI reality.
- The Telegraph story becomes a binary-asserted, re-runnable artifact instead of a narrative.

**Non-Goals:**

- No public dashboard or website work (the docs site consumes `status.json` later if wanted).
- No load/perf benchmarking; the benchmark asserts behavior, not speed.
- No change to what the acceptance tests test; this change runs and publishes them.

## Decisions

- **D1: Nightly schedule, not per-PR.** Live runs cost API credits and minutes; PRs keep the offline suite as their gate. Nightly catches provider drift and regressions within a day, which matches how fast model/API behavior actually changes. `workflow_dispatch` allows on-demand runs before releases.
- **D2: Evidence is committed, not stored as CI artifacts.** GitHub Actions artifacts expire and are invisible to readers; committed `demo-runs/<ac-id>/` entries (latest passing run only, replaced on newer pass) are linkable from the README and reviewable like everything else. Retention of one-per-AC keeps repo growth bounded. The workflow commits with a bot identity and `[skip ci]`.
- **D3: Promotion re-verifies redaction independently.** Before committing, the workflow greps the candidate files and the whole tree for `sk-[A-Za-z0-9_-]{20,}` (AC-4.1's pattern) and hard-fails on any hit, so a redaction bug cannot publish a key even though write-time redaction should have caught it. Defense in depth on the one irreversible failure mode.
- **D4: Benchmark traps are data, not prose.** `benchmarks/telegraph/traps.json` lists assertions (`budget_refusal`, expected constraint citations, drift catches, gate events) evaluated against the run's transcript and repo end-state by the runner script. The narrative README section links each claim to its trap id. Alternative: keep the story as documentation — rejected; unasserted stories rot.
- **D5: Maturity section is generated between markers.** `status.json` (per-AC pass state, per-provider, last-green timestamps) is written by the nightly workflow; `scripts/check-readme-consistency.ts` regenerates the README block between `<!-- maturity:begin/end -->` markers and fails CI when the committed README disagrees with a regeneration (same check covers the version claim vs `package.json`). Same drift-is-a-build-failure mechanic the product applies to hardware docs, applied to the repo itself.
- **D6: Benchmark runs from a scratch clone.** The runner copies the pinned brief into a temp directory, runs `create` there, and asserts; it never mutates the copperhead repo. Reproduction instructions are the same script with a user key.

## Risks / Trade-offs

- [Live-model nondeterminism makes nightly red noisy] → acceptance criteria are binary and were written to be model-agnostic; the workflow retries a failed AC once, and persistent reds are real signal (that is the point of running nightly). Flake-rate itself lands in `status.json` for honesty.
- [API cost creep] → matrix limited to the AC-3.x suite; nightly not hourly; toggle secret (`LIVE_ACCEPTANCE_ENABLED`) turns it off without editing workflows.
- [Committed transcripts grow the repo] → one latest-passing run per AC, transcripts are text and compress well in git; benchmark runs are summarized, with only the summary + trap results committed, not the full create transcript.
- [Bot commits fighting human pushes] → promotion commits touch only `demo-runs/` and `status.json`; rebase-and-retry once, then open a PR instead of pushing.

## Migration Plan

Infrastructure lands dark (workflow disabled until secrets are set). Enabling is adding the two keys and the toggle. Rollback is disabling the schedule; committed evidence remains valid history.

## Open Questions

- Whether the Anthropic key arrives in time to enable both matrix legs at merge (workflow handles a missing leg by marking it `not_run`, so this does not block).
- Whether `demo-runs/` promotion should also update the docs site examples (defer; the site can read the same files later).
