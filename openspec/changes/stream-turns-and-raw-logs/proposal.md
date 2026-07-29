# stream-turns-and-raw-logs: Proposal

## Why

Two gaps in what a run shows and what it leaves behind, both reported as "the logs are not written live":

1. **Turns arrived in one block.** The OpenAI and Anthropic providers issued non-streaming requests, so nothing reached the terminal until a turn finished. On a create-pipeline stage that is minutes of `[turn 4/40]`, a `thinking` status, and a heartbeat that always said "no output yet" — because the only streaming signal the loop had (`onStream`, a character count) was fed exclusively by the CLI-backed providers. The loop was already wired for streaming; nothing was feeding it.
2. **Nothing recorded the raw traffic or the console.** `transcript.jsonl` records what the loop *understood* — parsed text, parsed tool calls. When a provider returns something the loop mis-parses, the evidence needed to tell a copperhead bug from a provider bug was never written down. And a `do` or `create` run left no record of its own output at all: the REPL mirrors its session to a log, but one-shot runs had only the terminal scrollback.

## What Changes

- **Turns stream.** `OpenAIProvider` and `AnthropicProvider` request streaming responses and feed assistant text back through a new `ChatOpts.onText`; the loop prints it line by line as it arrives and does not reprint the completed turn. `claude-code` and `cursor` report through the same callback. Token accounting is unchanged: `stream_options.include_usage` on the OpenAI path and `finalMessage()` on the Anthropic path return the same usage the non-streamed call did.
- **A streaming refusal is not a failure.** An endpoint that rejects `stream`/`stream_options` (a partial OpenAI-compatible implementation, an unverified org) gets that turn retried once without streaming; the refusal is recorded in `raw.log` and the provider stops asking for the rest of the session.
- **New per-run `raw.log`**: verbatim provider traffic, one JSON object per line, written live — request and response payloads for the API providers, the CLI's own messages for `codex` / `claude-code` / `cursor`. Redacted at write time, per-entry and whole-file capped, and never able to fail a turn (an unserializable payload is noted, not raised).
- **New per-run `console.log`**: every durable line the run printed, ANSI stripped, written live. The transient status line and its in-place redraws are not mirrored — a file wants the record, not the animation.

## Capabilities

### Modified Capabilities

- `run-observability`: turns stream to the terminal; each run additionally writes `raw.log` and `console.log` beside its transcript, and AC-4.1 redaction extends to both.

## Impact

- **Code**: new `src/agent/rawlog.ts` (`RawLog`, `ConsoleMirror`); `ChatOpts` gains `onText` and `raw`; `openai.ts` and `anthropic.ts` switch to the SDKs' streaming helpers; `codex.ts`, `cursor.ts`, `claude-code.ts` report their traffic; `render.ts` gains `teeRenderer`; the loop line-buffers streamed text and opens both logs once the run dir exists.
- **Tests**: `test/rawlog.test.ts` (both writers plus an end-to-end run asserting the files and single-printing); the OpenAI stub servers now answer SSE and one asserts the non-streaming fallback; the Anthropic cache test drives the stream helper.
- **Docs**: `concepts/agent-loop.md` (run artifacts table, a "watching a turn happen" section), `reference/configuration.md`, SPEC §7 and AC-8.10 – AC-8.13.
- **Unchanged contracts**: token totals, transcript event shapes, `summary.md`, exit paths, and the redaction guarantee all hold; `check` stays LLM-free and network-free.
