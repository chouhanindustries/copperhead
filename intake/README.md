# copperhead intake

Datasheet intake and constraint verdict surface: point it at a component datasheet plus a proposed board change; it extracts typed, source-cited, confidence-scored facts and returns APPROVE / REFUSE / HOLD with the exact datasheet line and the exact rule line cited.

This workspace is self-contained and isolated from the root CLI build: its own `package.json`, `tsconfig.json`, and test suite. Nothing in `../src` depends on it, and root CI does not build it.

## Layout

- `core/`: pure TypeScript, no I/O, no SDKs, no clock. Data model, unit normalization, fact pipeline (snippet verification, bbox stitching, confidence gate at 0.75), the fail-closed verdict engine, and the reproducible verification manifest.
- `ports/`: the two provider interfaces (`DigitisationProvider`, `FactExtractor`) with typed errors.
- `adapters/`: Sarvam Digitise (async job flow, 90 s poll timeout, backoff on 429/503), the LLM fact extractor (claude-opus-5, structured outputs), the content-addressed cache, fixture providers, and the atomic-write registry store.
- `app/`: Next.js App Router UI (upload, facts with click-to-source, structured change form, verdict card, manifest export, correction flow) and API routes.
- `fixtures/`: the committed registry seed and the extraction cache (`fixtures/cache/`); cached results double as demo fixtures.
- `test/`: vitest suite, fully offline, including golden tests GT-1 through GT-5.

## Running

```bash
npm install
npm test          # offline suite
npm run dev       # UI at localhost:3000
```

Copy `.env.example` to `.env` and set `SARVAM_API_KEY` plus `ANTHROPIC_API_KEY` for live ingestion, or set `USE_FIXTURES=true` to serve cached results with zero network (the required demo fallback).

## Invariants

- The verdict engine is a pure function: no network, no clock, no LLM. Identical inputs give identical verdicts, and every exported manifest reproduces its verdict.
- A HOLD fact can never produce an APPROVE or REFUSE. Missing facts, malformed registries, unverifiable snippets, and unconvertible units all fail closed.
- The LLM extractor is untrusted by construction: a value whose verbatim snippet does not occur in the digitised text is held, and bounding boxes come only from deterministic snippet location.
- A datasheet is digitised once, ever; the extractor runs at most once per (document, field list).
