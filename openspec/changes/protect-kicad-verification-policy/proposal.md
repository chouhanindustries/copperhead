# protect-kicad-verification-policy: Proposal

## Why

The verification gate trusts KiCad's DRC result, but the agent can currently edit `.kicad_pro` before running DRC. A live layout run added project-level `ignore` severities for hole clearance, unconnected items, footprint mismatches, and silkscreen findings, reducing the report from 24 violations to 3 without resolving the underlying board conditions.

## What Changes

- Compare verification-sensitive `.kicad_pro` settings before an anchored edit writes the file.
- Refuse severity reductions, clearance reductions, and added verification exclusions.
- Preserve existing project ignores, tightening changes, exclusion removal, JSON repair, and unrelated project edits.

## Capabilities

### Modified Capabilities

- `agent-core`: project-file edits cannot weaken the verification policy used by later gates.

## Impact

- **Code**: the anchored editor supports pre-write validation and the project edit handler applies a semantic policy comparison.
- **Tests**: pure comparisons and handler integration prove fail-closed, atomic refusal.
- **Scope**: this protects `.kicad_pro`; it is not an exhaustive policy for every KiCad rule format.
