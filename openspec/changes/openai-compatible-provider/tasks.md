# Tasks — openai-compatible-provider

## 1. OpenSpec artifacts

- [x] 1.1 `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md`

## 2. Config layer

- [x] 2.1 Add `openaiCompatBaseUrl?: string` and `openaiCompatApiKeyEnv?: string` to `CopperheadConfig`
- [x] 2.2 Pass through in `loadConfig()` with the existing pattern
- [x] 2.3 `COPPERHEAD_BASE_URL` / `COPPERHEAD_API_KEY_ENV` env-var overrides

## 3. Provider

- [x] 3.1 Add `baseURL?: string` to `OpenAIProvider` constructor
- [x] 3.2 Accept configurable `apiKey` string (resolved by caller from named env var)
- [x] 3.3 Pass `baseURL` to the `OpenAI` SDK client constructor

## 4. makeProvider routing

- [x] 4.1 Extend `makeProvider(model, sessionResume, config?)` signature
- [x] 4.2 Thread `openaiCompatBaseUrl` / `openaiCompatApiKeyEnv` to `OpenAIProvider`
- [x] 4.3 Log one-line privacy notice at run-start when endpoint matches known free-tier domains

## 5. Doctor command

- [x] 5.1 `src/commands/doctor.ts` — KiCad check, provider/key check, endpoint probe, privacy warning
- [x] 5.2 Wire `copperhead doctor` in `src/cli.ts`

## 6. Docs

- [x] 6.1 `docs/src/content/docs/getting-started/free-stack.md`

## 7. Tests

- [x] 7.1 `test/openai-compat.test.ts` — offline coverage for provider, config, routing, doctor
- [x] 7.2 Extend safety tests for key-name indirection redaction

## 8. Verification

- [x] 8.1 `npm run typecheck`
- [x] 8.2 `npm run build`
- [x] 8.3 `npm test`
