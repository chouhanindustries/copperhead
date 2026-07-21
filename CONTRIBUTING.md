# Contributing to copperhead

Thanks for your interest in contributing. This document covers the practical setup and the one piece of paperwork we require.

## Development setup

Requirements: Node.js >= 20 and, for the KiCad integration paths, a local `kicad-cli` on your PATH.

```bash
npm install
npm run dev -- --help   # run the CLI from source via tsx
npm run typecheck       # tsc, no emit
npm test                # vitest, offline suite
npm run build           # compile to dist/
```

The offline test suite runs without any credentials. Integration tests that call an LLM are skipped automatically unless an API key environment variable is present, so `npm test` is safe to run anywhere.

## Making changes

- This repo uses spec-driven development with OpenSpec. Behavior changes should stay consistent with `openspec/specs/SPEC.md`; if your change alters spec-level behavior, update the spec alongside the code.
- Keep pull requests focused: one logical change per PR.
- Add or update tests for anything you change. The offline suite must stay green.

## Contributor License Agreement

Before we can merge your first pull request, you must sign our [Contributor License Agreement](.github/cla/CLA.md) (CLA). This is automated: when you open a PR, the CLA bot checks whether you have signed and, if not, posts instructions. Signing is a one-time comment on the PR; it covers all your future contributions.

Why a CLA and not just the Apache-2.0 inbound license: the CLA lets Chouhan Industries relicense the combined work in the future (for example, offering commercial licenses) while the project itself stays Apache-2.0. Your contributions remain yours; you grant us a broad license to them, as described in the agreement.

## License

copperhead is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contributions will be licensed under its terms, in addition to the grants in the CLA.
