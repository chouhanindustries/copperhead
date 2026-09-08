# add-cache-only-replay: Proposal

## Why

The response cache currently falls through to a live provider on every missing, corrupt, or unreadable entry. That is correct for normal recovery, but it cannot prove that an automated replay made zero model calls: a divergent prompt can silently spend tokens or reach the network. It also constructs the selected provider before consulting the cache, requiring credentials or a saved-login CLI even when every response is already recorded.

Issue #66 needs a deterministic replay of a real eight-stage `create` run. The replay must fail at the first divergent turn and must not use a live diagnosis provider after a stage failure.

## What Changes

- Add explicit `COPPERHEAD_LLM_CACHE_ONLY=1` replay mode.
- In that mode, skip provider construction, serve exact cache hits, and fail clearly on missing or unreadable entries.
- Prevent `create` stage diagnosis from constructing a live provider during cache-only replay.
- Preserve the existing read-through/write-through behavior when the mode is absent.

## Capabilities

### Added Capabilities

- `agent-core`: deterministic response-cache replay that fails closed without any live provider path.

## Impact

- **Code**: `src/agent/response-cache.ts`, `src/agent/loop.ts`, and the `create` recovery supervisor.
- **Tests**: focused cache and create-resilience coverage.
- **Default behavior**: unchanged; cache-only is explicit and opt-in.
- **Network and credentials**: unreachable in cache-only mode, including after a stage failure.
