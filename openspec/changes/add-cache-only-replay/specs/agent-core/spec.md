# agent-core: Delta Spec

## ADDED Requirements

### Requirement: Cache-only response replay fails closed

When `COPPERHEAD_LLM_CACHE_ONLY=1` and response caching is enabled, the agent loop SHALL use exact on-disk response-cache entries without constructing or calling the selected model provider. It SHALL preserve the existing cache key shape and SHALL report zero token usage for hits. A missing, corrupt, or unreadable entry SHALL fail explicitly without live provider, credential, SDK, CLI, subprocess, or network fallback. The `create` stage supervisor SHALL NOT construct a diagnosis provider after any cache-only stage failure. When cache-only mode is absent, cache misses SHALL retain their existing read-through/write-through behavior.

#### Scenario: Exact hit needs no provider

- **WHEN** cache-only mode replays a request whose model, messages, and tool catalog match an on-disk entry
- **THEN** the cached turn is returned with zero usage without constructing or calling the selected provider

#### Scenario: Missing entry fails closed

- **WHEN** cache-only mode computes a key with no corresponding cache entry
- **THEN** the run fails through its provider-error and rollback path with a clear cache-miss error, and no live provider is called

#### Scenario: Corrupt entry fails closed

- **WHEN** cache-only mode finds an entry that cannot be read or parsed
- **THEN** the run fails with the entry path and does not regenerate the response

#### Scenario: Create diagnosis remains offline

- **WHEN** a cached `create` stage fails or does not meet its completion contract in cache-only mode
- **THEN** the recovery supervisor stops locally without constructing a diagnosis provider

#### Scenario: Default cache behavior is unchanged

- **WHEN** cache-only mode is absent and a response-cache entry is missing or unreadable
- **THEN** the wrapper calls the selected provider and writes the regenerated turn as before
