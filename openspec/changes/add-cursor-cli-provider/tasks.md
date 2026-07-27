# Tasks — add-cursor-cli-provider

## 1. Shared protocol

- [x] 1.1 Extract `tool-protocol.ts` from claude-code; re-import in claude-code without behavior change

## 2. Provider

- [x] 2.1 Create `src/agent/providers/cursor.ts` with subprocess `runFn` seam
- [x] 2.2 Plan mode, sandbox, isolated workspace, session resume, tripwire
- [x] 2.3 Strip billed API keys from subprocess env

## 3. Routing and docs

- [x] 3.1 `makeProvider()` routes `cursor` / `cursor:<id>` before other providers; empty override throws
- [x] 3.2 Update config comment, cli help, `.env.example`, README, docs site, SPEC.md

## 4. Tests

- [x] 4.1 `test/cursor-provider.test.ts` offline
- [x] 4.2 Opt-in `COPPERHEAD_TEST_CURSOR` in agent-integration
- [x] 4.3 `npm run typecheck`, `npm test`, `npm run build`

## 5. Manual

- [x] 5.1 Manual test log in PR (edit sandbox, `--model cursor`)
