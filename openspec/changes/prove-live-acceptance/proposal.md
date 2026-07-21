# prove-live-acceptance: Proposal

## Why

The maturity story is currently "implemented, not yet proven": live acceptance runs have happened ad hoc (AC-3.1/3.4/3.5/3.6 observed on one model), but nothing makes them repeatable, visible, or regression-proof, and the README's claims drift from reality by hand-editing (roadmap Phase 0 and Phase 1). For a tool whose thesis is that drift is a build failure, its own repository must generate its evidence and hold its claims to the same standard.

## What Changes

- **Nightly live-acceptance CI**: a scheduled GitHub Actions workflow running the key-gated AC-3.x integration suite per provider (matrix: OpenAI, Anthropic) with `kicad-cli` installed, publishing per-run status to a badge matrix alongside the existing offline-suite badge.
- **Published run evidence**: passing acceptance runs promote their redacted `transcript.jsonl` + `summary.md` into a committed `demo-runs/` entry (one per AC, latest passing), linked from the README; the existing secret-redaction pass is re-verified by a full-tree grep in the workflow before commit.
- **Open Telegraph benchmark**: a pinned brief plus a runner script (`npm run benchmark:telegraph`) that executes `copperhead create --brief` from a clean state and checks a documented trap list (budget refusals, drift catches, gate behavior) as binary assertions; the same script is the reproduction path for readers.
- **Self-consistency check in CI**: the repo's own CI fails when the README's version claim disagrees with `package.json`, and the README maturity section is generated from a checked-in status file (`status.json`) updated by the nightly workflow, not hand-edited.

## Capabilities

### New Capabilities

- `acceptance-evidence`: the nightly live-run workflow and badge matrix, the published-transcript promotion rules (redaction re-check, latest-passing retention), the Telegraph benchmark runner and its trap-list assertion format, and the README self-consistency checks (version claim, generated maturity section).

### Modified Capabilities

(none: product CLI behavior is unchanged; this change is repo evidence infrastructure)

## Impact

- **Repo**: new `.github/workflows/live-acceptance.yml`, `scripts/benchmark-telegraph.ts`, `scripts/check-readme-consistency.ts`, `demo-runs/` promotion layout, `status.json`; README gains generated markers around the maturity section.
- **Secrets**: provider API keys as GitHub Actions secrets; never echoed; the existing `sk-` redaction and full-tree grep guard the published artifacts (AC-4.1 extended to CI).
- **Cost**: nightly live runs consume API credits; the matrix is small (the AC-3.x suite per provider) and skippable via workflow toggle.
- **Unchanged contracts**: no `src/` behavior changes; the offline suite and `check` contracts are untouched.
