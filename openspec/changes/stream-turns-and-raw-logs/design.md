# stream-turns-and-raw-logs: Design

## Context

The loop already had the shape of streaming: `ChatOpts.onStream` for liveness, a heartbeat that reports `streamedChars`, and a renderer that prints above a pinned status line. What it lacked was any provider feeding it — `client.chat.completions.create` and `client.messages.create` are both one-shot, so on an API key the heartbeat could only ever say "no output yet". Separately, the audit trail recorded interpretations (`assistant`, `tool`) but never the bytes those interpretations came from, and one-shot runs mirrored their console nowhere.

## Goals / Non-Goals

**Goals:**

- A long turn is watchable while it happens, on every provider that can stream.
- A run can be debugged after the fact from its own directory: what was sent, what came back, and what the operator saw.
- No change to token accounting, transcript shapes, or the redaction guarantee.

**Non-Goals:**

- Streaming tool-call arguments to the terminal. Partial JSON is noise; the SDK accumulators assemble tool calls and the loop prints the result.
- A live viewer or web surface (Phase 2).
- Replacing `transcript.jsonl`. The structured log stays the primary record; `raw.log` sits beside it.

## Decisions

- **D1: `onText` is a separate callback from `onStream`.** A provider that can report progress but not content (a CLI printing a spinner) implements one and not the other, and the heartbeat only ever needed a length. Widening `onStream` to carry text would have forced every caller to care about content it does not use.
- **D2: The loop line-buffers streamed text; the renderer is untouched.** The interactive renderer's invariant is that only complete lines go above the pinned status line. Buffering deltas in the loop and calling the existing `log()` per completed line keeps that invariant, avoids a new renderer method every implementor would have to add, and gives the console mirror well-formed lines for free. The partial line is flushed in the turn's `finally`, so an aborted or timed-out turn still shows what had arrived.
- **D3: A streamed turn is not reprinted.** The loop skips its end-of-turn `log(res.text)` when anything was streamed. This is the single most visible way the feature could go wrong (every turn doubled), so it is asserted directly in the tests.
- **D4: A streaming refusal downgrades once, per provider instance, not per turn.** Compat endpoints are OpenAI-shaped but not OpenAI; some reject `stream_options` outright. Retrying the turn without streaming turns a hard failure into a formatting difference, and latching the decision means an endpoint that said no is asked exactly once. The refusal is matched narrowly (a 4xx whose message mentions `stream`) so a genuine 400 still surfaces.
- **D5: `stream_options: {include_usage: true}` is mandatory on the OpenAI path.** Without it the streamed response carries no usage and every turn would report zero tokens — silently breaking the turn budget, the cost table, and AC-8.1. This is the one part of the change where a wrong default is invisible rather than loud, so it has its own assertion.
- **D6: `raw.log` is JSONL with an entry kind and a provider name.** Runs can fail over between providers mid-flight (`otherProvider()`), so attribution has to be per entry rather than per file. JSONL keeps it greppable and appendable; a full transcript-style schema would be a second thing to keep in sync with the first.
- **D7: Both logs are append-and-forget, serialized through a promise chain, and never throw.** A turn must not wait on a disk write, two concurrent writers must not interleave a half-written line, and a logging failure must not be the thing that fails a run. `runAgentLoop` settles both in its `finally`, so the files are complete before the caller reads them.
- **D8: Caps, not rotation.** A per-entry cap (256 KB, truncated with a marker) and a whole-file cap (64 MB, with a line saying so) mean a pathological run degrades its own log rather than the disk. Rotation would mean a run's evidence lives in more than one file, which is worse for the thing this exists to do.
- **D9: The console mirror tees the renderer, and skips transient output.** `teeRenderer` wraps the real renderer and copies every durable line — logs, turn markers, tool results, heartbeats, the outcome — to the mirror with ANSI stripped. The status line and its redraws are not mirrored: in a file they would be thousands of copies of the same line.

## Risks / Trade-offs

- **The console mirror is per run, not per command.** A `create` pipeline's stage banners are printed outside any run, so each stage's `console.log` covers that stage's turns rather than the whole pipeline. Accepted: the run directory is the unit that already holds the transcript, and the pipeline's own report (`REPORT.md`) covers the across-stage view.
- **An empty stream reads as an empty turn.** The SDK reports "no chunks" both for an endpoint that genuinely returned nothing and for a connection that died before the first byte. The provider treats it as the empty-response case the loop already tolerates (nudge, then fail on three in a row) rather than as an error, and records it in `raw.log` so the other cause is diagnosable.
- **`raw.log` contains full prompts.** That is the point, and it is why redaction runs on every write and why `.copperhead/runs/` is gitignored from the first commit (AC-4.3). Anyone attaching one to a bug report is attaching their design docs; the docs say so.
