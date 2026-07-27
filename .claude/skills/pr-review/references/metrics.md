# Metrics reference

The metrics block is produced by `scripts/metrics.mjs`. This file defines what each number means, how to run the script, and the manual fallback for when it cannot run. Report measured numbers, never impressions, and always say how each was obtained.

## Running the script

```bash
node .claude/skills/pr-review/scripts/metrics.mjs <pr-number>          # normal case
node .claude/skills/pr-review/scripts/metrics.mjs <pr-number> --base-tests   # also run the suite at the merge base
node .claude/skills/pr-review/scripts/metrics.mjs --base <ref>         # no PR yet: current branch vs a base ref
```

Requirements and behavior:

- The PR head must be checked out (`gh pr checkout <n>`) for the suite and coverage to run; otherwise the script still emits diff metrics and marks the rest "not measured".
- Everything is computed against the merge base (`git merge-base origin/<base> <head>`), so a stale branch is never scored against the wrong point.
- The base suite runs in a throwaway `git worktree` with a symlinked `node_modules`; the working tree is never switched. If base CI already reports the suite result, reading CI is cheaper than `--base-tests`.
- If `@vitest/coverage-v8` is missing, the script installs it with `npm i -D --no-save` so `package.json` and the lockfile stay clean.
- Generated files (`package-lock.json`, `dist/`, `*.snap`, `node_modules/`, `docs/.astro/`) are excluded from area splits and coverage, and reported on their own line.

## What each metric means

- **Change size**: additions, deletions, and net, split by area (`src/`, `test/`, `openspec/`, docs, other) so a docs-heavy diff is not mistaken for a code-heavy one.
- **New vs net**: brand-new files and lines (net-new behavior that needs its own tests) vs edits to existing code. "New" carries the most unreviewed risk; call it out separately.
- **Tests**: added test lines, and the suite result as pass/skip/fail at base and head. A source change adding zero test lines is a coverage flag unless it is untestable plumbing.
- **Diff coverage** (the headline metric): the percentage of changed *executable* src lines exercised by the suite, from vitest v8 coverage intersected with the changed lines in the diff. Comment, type, and blank changed lines are excluded from the denominator. The uncovered `file:line` list is the input to the untested-surface findings: enumerate the new exported symbols, branches, and error/early-return paths those lines contain, and put each in the findings list, not just the metrics block.
- **Deps**: added (`+[...]`), removed (`-[...]`), and version-changed (`~[...]`, with before and after versions) dependencies when `package.json` changed. Run `npm audit` on base and head for the advisory delta when deps actually changed.
- **CI**: pass/fail/pending counts across the PR's checks plus the failing and pending counts among required checks, from `gh pr checks --json bucket`. A failing required check is at least a medium finding.

## Manual fallback (script cannot run)

- Change size and new-vs-net: `BASE=$(git merge-base origin/<baseRef> <headRef>)`, then `git diff --numstat $BASE...<head>` and `--diff-filter=A`.
- Suite: `npm test` on the head branch; base result from CI.
- Coverage: map every new exported symbol, new branch (`if`/`else`/`catch`/`case`/`? :`), and new error path in the diff to the test that exercises it; the covered fraction is `mapped / total`. Cite the test names.
- Never emit a percentage you did not actually derive. If neither path is possible, write "diff coverage: not measured" and say why: a silent omission reads as "clean".

## Block template

Keep the block to a few lines; paste the script's output, or in fallback mode follow this shape:

```text
lines: +A / -D (net N) across F files  ·  src +A1/-D1, test +A2/-D2, docs +A3, spec +A4
new vs net: X new files, Y modified; Z new src lines (the net-new surface)
tests: +K test lines; suite P/S/F -> P'/S'/F' (pass/skip/fail, base -> head)
diff coverage: C% of changed src lines exercised (measured | manual); uncovered: file:line, ...
deps: <only if package.json changed>
ci: P pass / F fail / N pending; required checks: F' failing, N' pending
```

The uncovered-lines entry must reconcile with the untested-surface findings below it. The block's uncovered entry truncates at 40 files; when it does, the script prints the complete per-file list in its detail output, and that full list is the one to reconcile against.
