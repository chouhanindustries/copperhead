# Tasks: stream-turns-and-raw-logs

## 1. Streaming turns

- [x] 1.1 `ChatOpts` gains `onText` (assistant text, delta by delta) alongside the existing `onStream` length signal, and `raw` for verbatim traffic
- [x] 1.2 `OpenAIProvider` uses the SDK's streaming helper with `stream_options: {include_usage: true}` so usage survives the streamed path
- [x] 1.3 `AnthropicProvider` uses `messages.stream(...)` + `finalMessage()`, feeding `on('text')` deltas through `onText`
- [x] 1.4 A 4xx that names `stream` downgrades that turn to a single non-streamed request and latches the decision for the provider instance
- [x] 1.5 A stream that carries no completion resolves to the empty-response case the loop already tolerates, recorded in `raw.log` rather than raised
- [x] 1.6 `claude-code` and `cursor` report their text through `onText` too

## 2. Printing a turn as it arrives

- [x] 2.1 The loop line-buffers deltas and prints complete lines through the existing renderer (keeps the pinned-status-line invariant; no renderer interface change)
- [x] 2.2 The partial line is flushed in the turn's `finally`, so a timed-out or errored turn still shows what arrived
- [x] 2.3 The end-of-turn `log(res.text)` is skipped when the turn streamed, so nothing prints twice

## 3. Raw log

- [x] 3.1 New `src/agent/rawlog.ts`: `RawLog` (JSONL, per-entry `kind` + `provider`, redacted, per-entry and whole-file caps, unserializable payloads noted not raised)
- [x] 3.2 Serialized append-and-forget writer that never throws; `runAgentLoop` settles it in its `finally`
- [x] 3.3 The loop binds a per-provider sink and passes it into every `provider.chat` call
- [x] 3.4 `openai`, `anthropic`, `codex`, `cursor`, `claude-code` record their own request/response traffic

## 4. Console mirror

- [x] 4.1 `ConsoleMirror` (plain text, ANSI stripped, same writer and caps)
- [x] 4.2 `teeRenderer` in `render.ts` copies durable lines (log, turn marker, tool result, heartbeat, outcome) to a sink; the status line is not mirrored
- [x] 4.3 The loop wraps its renderer and attaches the mirror once the run directory exists

## 5. Tests

- [x] 5.1 `test/rawlog.test.ts`: JSONL shape and attribution, redaction, unserializable payload, truncation, ANSI stripping
- [x] 5.2 End-to-end run: `raw.log` and `console.log` land beside the transcript, the loop passes both callbacks, streamed text prints exactly once, and a non-streaming provider's turn also prints exactly once
- [x] 5.3 OpenAI stub servers answer SSE; the wire-contract test asserts `stream` + `stream_options`, and a new test drives the non-streaming fallback and its latching
- [x] 5.4 The Anthropic prompt-caching test drives the stream helper and asserts the deltas reach `onText`

## 6. Docs

- [x] 6.1 `concepts/agent-loop.md`: run-artifacts table (four files, what each is, when written) and a "watching a turn happen" section covering the heartbeat and the streaming fallback
- [x] 6.2 `reference/configuration.md`: the run-directory row lists all four artifacts
- [x] 6.3 SPEC.md: §7 redaction covers every run artifact; AC-8.10 extended; AC-8.11 (turns stream), AC-8.12 (verbatim traffic), AC-8.13 (console mirror) added
