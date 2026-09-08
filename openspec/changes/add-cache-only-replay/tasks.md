# add-cache-only-replay: Tasks

## 1. Strict cache behavior

- [x] 1.1 Add an explicit cache-only opt-in without changing default read-through behavior
- [x] 1.2 Fail clearly on missing, corrupt, or unreadable cache entries before the inner provider can run
- [x] 1.3 Skip selected-provider construction during cache-only replay
- [x] 1.4 Prevent the `create` recovery supervisor from constructing a live diagnosis provider

## 2. Coverage

- [x] 2.1 Prove an exact loop-level cache hit works without credentials or provider construction and reports zero usage
- [x] 2.2 Prove a divergent loop-level request fails through the provider-error path without fallback
- [x] 2.3 Prove a corrupt entry does not call the inner provider
- [x] 2.4 Prove a failed `create` stage does not invoke diagnosis in cache-only mode

## 3. Specification and validation

- [x] 3.1 Add the cache-only contract to the source specification and focused OpenSpec change
- [x] 3.2 Run focused tests, typecheck, strict OpenSpec validation, Markdown lint, and diff checks
- [x] 3.3 Run the complete offline suite (946 passed, 21 skipped)
