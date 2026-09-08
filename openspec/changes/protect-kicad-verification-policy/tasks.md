# protect-kicad-verification-policy: Tasks

## 1. Project policy guard

- [x] 1.1 Compare rule severities, explicit clearances, and verification exclusions semantically
- [x] 1.2 Validate the complete anchored candidate before writing a `.kicad_pro`
- [x] 1.3 Preserve existing ignores, tightening edits, and repair of invalid project JSON

## 2. Regression coverage

- [x] 2.1 Cover severity, clearance, exclusion, valid-edit, and JSON-repair behavior
- [x] 2.2 Prove a refused handler edit leaves file bytes and touched state unchanged

## 3. Specification and validation

- [x] 3.1 Add the source and delta specification requirements
- [x] 3.2 Run focused tests, typecheck, Markdown lint, and OpenSpec validation
