# fix-generated-power-symbol-verification: Tasks

## 1. Verification boundary

- [x] 1.1 Recognize exact engine-generated rail, ground, and `PWR_FLAG` semantics
- [x] 1.2 Exclude recognized generated entries without counting them as installed-library checked or unavailable
- [x] 1.3 Preserve normal verification for altered prefixed entries and ordinary vendored symbols
- [x] 1.4 Align the `verify_symbols` tool description with the verification boundary

## 2. Regression coverage

- [x] 2.1 Verify a real deterministic draft with generated power entries and ordinary vendored symbols
- [x] 2.2 Prove an altered private-prefix entry is not exempt
- [x] 2.3 Preserve the existing ordinary-symbol library-drift regression

## 3. Specification and validation

- [x] 3.1 Add the source and delta specification requirements
- [x] 3.2 Run focused tests, typecheck, Markdown lint, and OpenSpec validation
