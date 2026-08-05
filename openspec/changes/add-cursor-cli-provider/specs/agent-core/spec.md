# agent-core — Delta Spec

## MODIFIED Requirements

### Requirement: Provider list includes Cursor provider

Provider list (§4.4) SHALL include `cursor.ts`: saved-login Cursor Agent CLI subprocess, reasoning-only (plan mode + tripwire), JSON tool protocol, session resume via `--resume`.

#### Scenario: Cursor provider is available
- **WHEN** a user selects `--model cursor`
- **THEN** the Cursor provider is available and behaves according to the specification

### Requirement: Provider parity includes Cursor

AC-3.10 provider parity SHALL include `--model cursor` when `COPPERHEAD_TEST_CURSOR=1` and the CLI is authenticated.

#### Scenario: Cursor provider participates in parity tests
- **WHEN** `COPPERHEAD_TEST_CURSOR=1` and the Cursor CLI is authenticated
- **THEN** provider parity tests include the `cursor` provider