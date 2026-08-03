# Tasks — cap the re-sent conversation

## 1. Capping module

- [x] 1.1 New `src/agent/history.ts` with `capHistory(messages, opts)` returning `{ messages, stats }`, plus `HISTORY_CAP_DEFAULTS`. Builds a new array; the caller's is never mutated (D1). Verified: `test/history-cap.test.ts` ("never mutates the caller's array").
- [x] 1.2 Preserve length, order, roles, and `toolCallId` exactly; shrink only content and oversized argument strings (D2). Verified: `test/history-cap.test.ts` ("preserves length, order, roles, and tool-call ids exactly"), which also renders through `renderDelta` at the resume index to prove the session-resume slice still lands.
- [x] 1.3 Supersede a `read_file` result when a later read of the same path exists, at any distance; never supersede the newest read of a path (D3). Verified: three tests — supersession fires, the newest read survives in full, different paths stay independent.
- [x] 1.4 Head-and-tail clip oversized tool results and tool-call argument strings, outside the recent window only, each with an in-band marker (D4). Verified: two tests asserting head/tail retention, the marker text, and that short arguments (`path`) pass through untouched.

## 2. Wiring

- [x] 2.1 Cap at the `provider.chat` call site in `src/agent/loop.ts`, sending the capped view while keeping `messages` whole for the transcript and the next turn's pass. Verified: `npm run typecheck` + full suite green (592 passed).
- [x] 2.2 Record the saving: `capCharsSaved` on `RunStats` and a per-turn `history-capped` transcript event, emitted only when a turn actually trimmed something.

## 3. Config

- [x] 3.1 New `historyCap` boolean on `CopperheadConfig`, defaulting true, parsed as `raw.historyCap !== false` to match `llmCache`'s existing idiom. Off reproduces a run's exact prompts.

## 4. Tests

- [x] 4.1 Invariants: length/order/role/id parity, no caller mutation, short conversations returned untouched.
- [x] 4.2 Behavior: supersession (fires, newest survives, path-independent), result clipping, argument clipping, recent window left verbatim.
- [x] 4.3 End-to-end shrinkage through `renderConversation`, and a realistic schematic-stage fixture on the real defaults. **This test found a real design flaw**: with the recent window protecting *all* trims, capping barely fired, because the window was shielding the largest and most recent schematic re-reads. Fixed by D3 (supersession ignores the window, truncation respects it). Measured after the fix: 260,134 → 71,105 rendered chars, a 72.7% reduction (~47k tokens) on one turn, message count unchanged.

## 5. Spec coherence

- [x] 5.1 New `cap-agent-history` change with proposal, design (D1–D6), and an `agent-core` delta spec carrying three requirements and six scenarios. `openspec validate cap-agent-history` passes.
- [ ] 5.2 Add an AC to `SPEC.md`'s AC-3 block once the change is accepted, mapping 1:1 onto the delta spec's requirements, and fold the delta into `openspec/specs/` at archive time.

## 6. Follow-ups (not in this change)

- [ ] 6.1 Session resume for `claude-code` is implemented but opt-in behind `COPPERHEAD_CC_SESSION_RESUME=1` *and* mutually exclusive with `llmCache`, which defaults on — so the second-largest token saving is off by default. Worth revisiting whether the two can coexist.
- [ ] 6.2 The OpenAI/compat provider sends no prompt-cache breakpoints, unlike the Anthropic provider's three. Relevant to the compat route's TPM-limited endpoints.
- [ ] 6.3 Measure capping against a live run and record real per-stage token deltas next to the `pipeline-run-logs/` baselines; the 72.7% figure is a synthetic fixture, not a live run.
