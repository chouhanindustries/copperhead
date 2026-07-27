# General review checklist

Applies to the general-review pass (inline or as a subagent). The goal: correctness, edge cases, error handling, test coverage for new behavior, and whether the PR does what its description claims. Flag scope creep (changes unrelated to the stated purpose).

## Format- and protocol-handling code gets adversarial inputs

Any code that parses or serializes model output or structured text (tool-call parsers, the s-expression reader, BOM/table parsers, JSON or markdown extractors) must be checked against hostile-but-realistic payloads, not only the tidy happy path:

- embedded or nested delimiters: the format inside the format, e.g. a fenced code block appearing inside content that is itself delimited by fences
- the empty / one / many cases
- very large content
- unicode
- malformed input

Construct the payload and trace the code by hand; a passing mock test with clean inputs is not evidence this class works. This is where real defects hide.

## Mock-only runtime code is flagged

If provider, subprocess, or integration code is exercised only through injected fakes, say so plainly: the real path (SDK, CLI, or network message shapes) is unverified by the suite. Recommend a bounded live smoke where one is feasible.

## New tests must be deterministic and must assert

They may not hit the network, use `Date.now()` / `Math.random()` / wall-clock, or depend on execution order, and a test that runs without asserting anything is not coverage. Flag any that break these.

## Finding format

Every finding states: a one-sentence claim, the file and line, a concrete failure scenario (the inputs or state that lead to wrong behavior), and a concrete fix, either a one-line change or a failing test that reproduces it.
