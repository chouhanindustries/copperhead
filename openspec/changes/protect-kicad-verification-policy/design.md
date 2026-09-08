# protect-kicad-verification-policy: Design

## Context

KiCad schematic and board edits are load-probed, but a project file is JSON and cannot be validated by loading it as either artifact. Leaving `.kicad_pro` unprobed is correct for syntax compatibility, yet permits an agent to change the severity and constraint policy that gives the later DRC gate its meaning.

## Goals / Non-Goals

**Goals:**

- Refuse observed verification-policy weakening before it reaches disk.
- Keep the anchored edit atomic on refusal.
- Preserve known bootstrap ignores and ordinary project maintenance.

**Non-Goals:**

- No relaxation of ERC, DRC, or finish gates.
- No blanket ban on `.kicad_pro` edits.
- No claim to cover `.kicad_dru` or every policy representation KiCad supports.

## Decisions

- **D1: Compare semantic JSON before writing.** The anchored editor constructs the candidate text and invokes a validator before `writeFile`; string formatting and property order do not affect the decision.
- **D2: Changes must be monotonic for known verification settings.** Existing ignores can remain. New severities must be `error`; existing severities can only become stricter. Existing numeric clearance values cannot decrease or disappear. Verification exclusion arrays cannot gain entries.
- **D3: Preserve repair.** Invalid candidate JSON is refused. When the original project is already invalid, an edit that produces valid JSON is allowed because there is no trustworthy baseline to compare.

## Risks / Trade-offs

- The comparison intentionally covers the project settings used in the observed bypass, not all KiCad rule sources. Other formats need their own parser and contract rather than string matching here.
- A newly added clearance with no prior semantic path has no known baseline and is not classified as a decrease. Existing clearance decreases and removals are protected.
