---
name: pr-review
description: Review a copperhead pull request against the repo's invariants and spec workflow. Use when the user asks to review a PR, e.g. /pr-review 28 or /pr-review <url>.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*)
compatibility: Requires the gh CLI, authenticated against chouhanindustries/copperhead.
metadata:
  author: copperhead
  version: "1.2"
---

Review a pull request for this repository. Present the findings report to the user, and also post it to the PR automatically as a comment (`gh pr comment <n>`) so the review is recorded on GitHub. Do NOT submit a formal review (`gh pr review --approve` / `--request-changes`) unless the user explicitly asks: those affect merge gating, whereas a plain comment does not.

**Input**: a PR number or URL. If omitted, run `gh pr list --json number,title,author,headRefName` and either auto-select the single open PR or use the AskUserQuestion tool to let the user pick. Always announce which PR is being reviewed.

**Steps**

1. **Gather the change**
   - `gh pr view <n> --json title,body,author,baseRefName,headRefName,files,additions,deletions,mergeable,isDraft`, plus `gh pr checks <n>` for CI state. Surface both in the report: a `mergeable` that is not `MERGEABLE` (behind base or conflicting) and a red or pending CI run each go in the metrics block, and a failing required check is at least a medium finding.
   - `gh pr diff <n>` for the full diff. For large PRs, read the diff per file. Skip generated and vendored files (`package-lock.json`, `dist/`, `*.snap`, build output): note that they changed, but do not read them line by line or raise findings inside them.
   - Read the surrounding context of every changed hunk in the working tree (or via `gh api`) so findings are grounded in real code, not diff fragments.
   - **Prior passes and authorship**: check the PR's existing comments for an earlier automated pr-review pass. If one exists, reference it and report only what changed since (new commits, findings now resolved or still open), not a duplicate full report. If you (the reviewer) authored any commit under review, disclose it up front and treat those findings as self-review, which warrants more skepticism, not less.

2. **General review**: correctness, edge cases, error handling, test coverage for new behavior, and whether the PR does what its description claims. Flag scope creep (changes unrelated to the stated purpose). In particular:
   - **Format- and protocol-handling code gets adversarial inputs.** Any code that parses or serializes model output or structured text (tool-call parsers, the s-expression reader, BOM/table parsers, JSON or markdown extractors) must be checked against hostile-but-realistic payloads, not only the tidy happy path: embedded or nested delimiters (the format inside the format, e.g. a fenced code block appearing inside content that is itself delimited by fences), the empty / one / many cases, very large content, unicode, and malformed input. Construct the payload and trace the code by hand; a passing mock test with clean inputs is not evidence this class works. This is where real defects hide.
   - **Mock-only runtime code is flagged.** If provider, subprocess, or integration code is exercised only through injected fakes, say so plainly: the real path (SDK, CLI, or network message shapes) is unverified by the suite. Recommend a bounded live smoke where one is feasible.
   - **New tests must be deterministic and must assert.** They may not hit the network, use `Date.now()` / `Math.random()` / wall-clock, or depend on execution order, and a test that runs without asserting anything is not coverage. Flag any that break these.

3. **Repo invariant checks** (each is a hard requirement from SPEC.md; violations are high severity):
   - **Spec-gated in**: `edit_file`/`write_file` must remain structurally absent from the agent tool list until an OpenSpec proposal validates. Reject any change that exposes mutation tools unconditionally or gates them by prompt text instead of by omission.
   - **Verification-gated out**: mutations must still end in ERC (and DRC when the board changed) passing, with repair up to `maxRepairCycles` then rollback to the git snapshot. Watch for paths that skip verification or mark a run done early.
   - **`check`/`verify` stays LLM-free and network-free**: no change may make `src/commands/check` (or anything it imports) touch a provider, an API key, or the network.
   - **No sexp serialization**: the parser in `src/kicad/` is read-only; KiCad files are edited only via anchored exact-match text replace. Reject any round-tripping.
   - **Sync-obligations ledger**: post-tool-call hooks must keep feeding the ledger, and commit must keep refusing while obligations are open.
   - **Secrets**: transcripts and summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars; `.gitignore` keeps `.env` and `.copperhead/runs/`.

4. **Spec coherence**: if the PR changes spec-level behavior, `openspec/specs/SPEC.md` and the active change artifacts (`proposal.md`, `design.md`, delta specs, `tasks.md`) must move together. Run `openspec validate build-copperhead-phase-1` when planning artifacts changed. A code-only PR that silently diverges from SPEC.md is a finding.

5. **Coverage and change metrics**: quantify the change and how much of the *new* code is actually exercised. Report measured numbers, never impressions, and always say how each was obtained. Compute against the merge base, `BASE=$(git merge-base origin/<baseRef> <headRef>)`, so a stale branch is not scored against the wrong point.
   - **Change size**: total additions, deletions, and *net* (additions minus deletions) across the touched files, from `gh pr view <n> --json additions,deletions,files` or `git diff --stat $BASE...<head>`. Split it by area (`src/` source vs `test/` vs docs vs `openspec/`) with `git diff --numstat $BASE...<head>` so a docs-heavy diff is not mistaken for a code-heavy one.
   - **New vs net code**: distinguish brand-new code (added files and added lines: net-new behavior that needs its own tests) from edits to existing code (modified lines, covered by existing plus updated tests). Per changed `src/` file, report added/removed line counts (`--numstat`) and flag added files (`--diff-filter=A`). "New" is what carries the most unreviewed risk; call it out separately from the net figure.
   - **Test-to-code ratio and suite delta**: added test lines vs added source lines, and the change in test count. Run `npm test` on the PR branch and on `$BASE` (or read the reported totals) and report `pass/skip/fail` before and after. A source change that adds zero test lines is a coverage flag unless it is untestable plumbing.
   - **Diff coverage (which changed lines are exercised)**, the headline metric, reported for *new/changed `src/` lines*, not whole-repo coverage:
     - Preferred (measured): if `@vitest/coverage-v8` resolves (or after a throwaway `npm i -D @vitest/coverage-v8`), run `npx vitest run --coverage --coverage.reporter=json`, then intersect the per-line coverage with the changed `src/` lines from the diff. Report the percentage of changed source lines covered and name the uncovered ones with `file:line`.
     - Fallback (manual, when coverage cannot run): map every new exported symbol, new branch (`if`/`else`/`catch`/`case`/`? :`), and new error path in the diff to the test that exercises it; the covered fraction is `mapped / total`. Cite the test names. Never emit a percentage you did not actually derive; if neither path is possible, say "diff coverage: not measured" and explain why.
   - **Untested-surface list**: enumerate the new exported symbols, new branches, and new error/early-return paths in `src/` that no test reaches. These are the highest-value findings, and each belongs in the findings list, not just the metrics block.
   - **Other signals worth a line when present**: new runtime dependencies and the `npm audit` advisory delta (base vs head) for any `package.json` change; the largest single changed file or function (a hotspot for defects); and net public-API surface change (new exported functions/types/CLI flags). Skip any that do not apply rather than padding.

6. **Verify before reporting**: for each candidate finding, re-read the code and try to refute it. Drop anything speculative or already handled elsewhere. If the PR touches build or tests, run `npm test` locally on the PR branch when feasible and report actual results, never assumed ones. Pay special attention to the untested-surface list from step 5: an uncovered new branch or error path is exactly where a real defect hides, so trace each one by hand before concluding it is fine.

**Output**

A short verdict first (approve / approve with nits / request changes), then a compact **metrics block**, then findings ranked by severity. Each finding states: a one-sentence claim, the file and line, a concrete failure scenario (the inputs or state that lead to wrong behavior), and a concrete fix, either a one-line change or a failing test that reproduces it. For a confirmed correctness bug prefer the repro test, mirroring the repo's regression-test habit. Note explicitly which invariant checks were performed and passed, so a clean report is distinguishable from an unexamined one.

**Severity rubric** (apply it consistently so a level means the same thing across runs):
- **high**: a repo-invariant violation (step 3), data loss or an unrecoverable run, a secret leak, or a correctness bug on the default path.
- **medium**: a correctness bug on a reachable non-default path, a skipped or weakened verification, or a failing required CI check.
- **low**: an edge case, a coverage gap, a doc or naming issue, or style.

The metrics block gives the shape of the change at a glance (from step 5). Keep it to a few lines, for example:

```
lines: +A / -D (net N) across F files  ·  src +A1/-D1, test +A2/-D2, docs +A3, spec +A4
new vs net: X new files, Y modified; Z new src lines (the net-new surface)
tests: +K test lines; suite P/S/F -> P'/S'/F' (pass/skip/fail, base -> head)
diff coverage: C% of changed src lines exercised (measured | manual); uncovered: file:line, ...
deps/audit: <only if package.json changed> +dep(s); audit advisories base -> head
```

State the method for each number and, if a metric could not be measured, say so explicitly rather than omitting it (a silent omission reads as "clean"). The uncovered-lines entry must reconcile with the untested-surface findings below it.

After presenting the report to the user, post the same report to the PR automatically with `gh pr comment <n> --body <report>`, opening it with a line that marks it as an automated pr-review pass (so a human review is not implied). Announce that you posted it and link the comment. Only if the user then explicitly asks to submit a formal review, use `gh pr review <n>` with the appropriate `--approve` / `--request-changes` / `--comment` flag and the findings as body.

If the host exposes a `ReportFindings` structured-output tool, also emit the verified findings through it (most severe first, empty when none survived), in addition to the GitHub comment, so a host UI can render them.
