# add-cache-only-replay: Design

## Context

`CachingProvider` is a read-through/write-through wrapper. `runAgentLoop` currently constructs the selected provider before wrapping it, and `runCreate` independently constructs a provider to diagnose an unsuccessful stage. A deterministic replay therefore needs two closed doors: cache misses must not call the wrapped provider, and stage recovery must not call the diagnosis provider.

## Decisions

- **D1: Explicit environment opt-in.** Only the exact value `COPPERHEAD_LLM_CACHE_ONLY=1` enables strict replay. Existing users keep read-through caching by default.
- **D2: Skip provider construction.** The loop uses a local unreachable fallback object solely to satisfy the wrapper interface. `CachingProvider` resolves hits first and throws on a miss before that object can run. This avoids SDK imports, credentials, CLI processes, and network clients.
- **D3: Fail on unreadable entries.** A present but corrupt cache file is a replay divergence, not permission to regenerate. The error names the cache path and states that no live provider was called.
- **D4: Disable live stage diagnosis.** The `create` supervisor returns an abort verdict locally in cache-only mode. A stage failure cannot escape into `makeProvider` through the diagnosis path.
- **D5: Retain exact keys.** Model id, compat endpoint scoping, raw messages, and advertised tool names keep their existing hash shape. This mode changes miss behavior only.

## Risks / Trade-offs

- Response-cache keys include raw prompt content, so dates, run identifiers, host-dependent tool output, and absolute paths can make a recorded cache non-portable. The later #66 fixture must control or detect those inputs; cache-only mode intentionally exposes divergence rather than normalizing it.
- Cache-only requires `llmCache` to remain enabled and rejects an injected provider, since either combination would make the opt-in misleading.

## Migration Plan

No migration is required. Existing cache files retain their names and JSON format. Removing the environment variable restores normal read-through/write-through behavior.
