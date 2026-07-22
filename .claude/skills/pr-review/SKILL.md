---
name: pr-review
description: Review a copperhead pull request against the repo's invariants and spec workflow. Use when the user asks to review a PR, e.g. /pr-review 28 or /pr-review <url>.
allowed-tools: Bash(gh:*), Bash(git:*), Bash(openspec:*), Bash(npm:*)
compatibility: Requires the gh CLI, authenticated against chouhanindustries/copperhead.
metadata:
  author: copperhead
  version: "1.0"
---

Review a pull request for this repository. Present the findings report to the user, and also post it to the PR automatically as a comment (`gh pr comment <n>`) so the review is recorded on GitHub. Do NOT submit a formal review (`gh pr review --approve` / `--request-changes`) unless the user explicitly asks: those affect merge gating, whereas a plain comment does not.

**Input**: a PR number or URL. If omitted, run `gh pr list --json number,title,author,headRefName` and either auto-select the single open PR or use the AskUserQuestion tool to let the user pick. Always announce which PR is being reviewed.

**Steps**

1. **Gather the change**
   - `gh pr view <n> --json title,body,author,baseRefName,headRefName,files,additions,deletions`
   - `gh pr diff <n>` for the full diff. For large PRs, read the diff per file.
   - Read the surrounding context of every changed hunk in the working tree (or via `gh api`) so findings are grounded in real code, not diff fragments.

2. **General review**: correctness, edge cases, error handling, test coverage for new behavior, and whether the PR does what its description claims. Flag scope creep (changes unrelated to the stated purpose).

3. **Repo invariant checks** (each is a hard requirement from SPEC.md; violations are high severity):
   - **Spec-gated in**: `edit_file`/`write_file` must remain structurally absent from the agent tool list until an OpenSpec proposal validates. Reject any change that exposes mutation tools unconditionally or gates them by prompt text instead of by omission.
   - **Verification-gated out**: mutations must still end in ERC (and DRC when the board changed) passing, with repair up to `maxRepairCycles` then rollback to the git snapshot. Watch for paths that skip verification or mark a run done early.
   - **`check`/`verify` stays LLM-free and network-free**: no change may make `src/commands/check` (or anything it imports) touch a provider, an API key, or the network.
   - **No sexp serialization**: the parser in `src/kicad/` is read-only; KiCad files are edited only via anchored exact-match text replace. Reject any round-tripping.
   - **Sync-obligations ledger**: post-tool-call hooks must keep feeding the ledger, and commit must keep refusing while obligations are open.
   - **Secrets**: transcripts and summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars; `.gitignore` keeps `.env` and `.copperhead/runs/`.

4. **Spec coherence**: if the PR changes spec-level behavior, `openspec/specs/SPEC.md` and the active change artifacts (`proposal.md`, `design.md`, delta specs, `tasks.md`) must move together. Run `openspec validate build-copperhead-phase-1` when planning artifacts changed. A code-only PR that silently diverges from SPEC.md is a finding.

5. **Verify before reporting**: for each candidate finding, re-read the code and try to refute it. Drop anything speculative or already handled elsewhere. If the PR touches build or tests, run `npm test` locally on the PR branch when feasible and report actual results, never assumed ones.

**Output**

A short verdict first (approve / approve with nits / request changes), then findings ranked by severity. Each finding: one-sentence claim, the file and line, and a concrete failure scenario. Note explicitly which invariant checks were performed and passed, so a clean report is distinguishable from an unexamined one.

After presenting the report to the user, post the same report to the PR automatically with `gh pr comment <n> --body <report>`, opening it with a line that marks it as an automated pr-review pass (so a human review is not implied). Announce that you posted it and link the comment. Only if the user then explicitly asks to submit a formal review, use `gh pr review <n>` with the appropriate `--approve` / `--request-changes` / `--comment` flag and the findings as body.
