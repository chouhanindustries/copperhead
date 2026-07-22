# safety-rails delta spec

## ADDED Requirements

### Requirement: Failed work preserved before rollback

Before restoring the pre-run snapshot on any run failure, the loop SHALL preserve the working tree's changes (tracked and untracked, honoring `.gitignore`) as a git stash entry named `copperhead failed run <run-id>`, log the stash reference with a recovery hint, and record a `work-preserved` event in the transcript. A clean tree SHALL produce no stash entry. Preservation failure SHALL NOT block the rollback itself.

#### Scenario: Budget exhaustion no longer destroys work (AC-15.16)

- **WHEN** a run fails with files touched (for example turn-budget exhaustion after the user declines to continue)
- **THEN** `git stash list` contains an entry named with the run id holding every touched file, and the working tree is still restored byte-identical to the pre-run snapshot

#### Scenario: Clean failure leaves no stash (AC-15.17)

- **WHEN** a run fails before touching any file
- **THEN** no new stash entry is created
