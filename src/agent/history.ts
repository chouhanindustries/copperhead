import type { Msg, ToolCall } from './types.js';

/**
 * Shrinks what a turn actually sends the model, without changing what the run
 * recorded.
 *
 * Every provider re-sends the whole conversation on every turn (the claude-code
 * provider flattens it with `renderConversation`; the keyed providers post the
 * full `messages` array), so an untrimmed history costs roughly quadratically in
 * turns. The schematic stage is where that bites: a `.kicad_sch` is tens of kB,
 * the model reads it repeatedly, and every stale copy is re-billed on every
 * later turn. Measured create runs spent 40–48k output tokens per stage, most of
 * it re-sent history rather than new work.
 *
 * Two invariants make this safe to drop in front of any provider:
 *
 * 1. **Length, order, roles, and ids are preserved exactly.** Only `content`
 *    strings (and oversized tool-call argument strings) shrink. The claude-code
 *    session-resume path slices by index (`renderDelta(messages, sentCount)`,
 *    with `sentCount = messages.length`), and every provider pairs a `tool`
 *    message to its call by `toolCallId` - both break if messages are dropped or
 *    reordered, so capping never does either.
 * 2. **The transcript is untouched.** Capping builds a view for the request; the
 *    JSONL transcript and the obligations ledger still see full fidelity, so a
 *    postmortem loses nothing.
 *
 * Trimming is always announced in-band. A truncated result says how much was cut
 * and how to get it back (`read_file` with a line range), because a model that
 * cannot tell "this file is short" from "this file was clipped" will confidently
 * reason about content it never saw.
 */
export interface HistoryCapOptions {
  /** Longest single tool result kept verbatim, in characters. */
  maxToolResultChars: number;
  /** Longest single tool-call argument string kept verbatim, in characters. */
  maxToolArgChars: number;
  /**
   * How many messages at the end of the conversation are never *truncated*. The
   * current state of the work lives here, so recent output goes over the wire
   * verbatim.
   *
   * Supersession deliberately ignores this window: dropping a read that a later
   * read of the same path already replaced is safe at any distance, because the
   * replacement is itself in the conversation. Protecting stale reads by recency
   * would shield exactly the largest items - a 30kB schematic re-read two turns
   * ago - which is most of the cost this exists to remove.
   */
  keepRecent: number;
}

export const HISTORY_CAP_DEFAULTS: HistoryCapOptions = {
  // Comfortably fits a normal file read and every report kicad-cli produces,
  // while clipping the multi-tens-of-kB schematic reads that drive the blowup.
  maxToolResultChars: 4000,
  // An anchored KiCad edit is the big one: `new_string` can carry a whole
  // subsystem of s-expressions. Once applied, the payload is in the file, so a
  // settled call does not need to keep restating it.
  maxToolArgChars: 2000,
  // Two full turns' worth of assistant + tool-result traffic, so the model
  // always retains the edit it just made and the report it just read.
  keepRecent: 12,
};

/** Result of one capping pass, for the run's efficiency accounting. */
export interface HistoryCapStats {
  /** Characters removed from what the provider was sent. */
  charsSaved: number;
  /** Tool results replaced because a newer read of the same path exists. */
  superseded: number;
  /** Oversized results and arguments clipped in place. */
  truncated: number;
}

/** Head/tail-preserving clip: the shape of a file matters as much as its start. */
function clip(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const cut = text.length - max;
  return `${text.slice(0, head)}\n\n… [${cut} characters elided — ${note}] …\n\n${text.slice(text.length - tail)}`;
}

/** The path a tool call operated on, when it names one. */
function pathOf(call: ToolCall): string | null {
  const p = call.args?.path;
  return typeof p === 'string' && p ? p : null;
}

/**
 * Build the capped view of a conversation.
 *
 * Returns a new array; the input is never mutated. Callers pass the result
 * straight to `provider.chat` and keep the original for the transcript.
 */
export function capHistory(
  messages: Msg[],
  opts: HistoryCapOptions = HISTORY_CAP_DEFAULTS,
): { messages: Msg[]; stats: HistoryCapStats } {
  const stats: HistoryCapStats = { charsSaved: 0, superseded: 0, truncated: 0 };
  // Below the protected window nothing can be truncated; supersession can still
  // fire, but it needs at least two reads of one path to have anything to do, so
  // a short conversation is returned untouched either way.
  const truncateBefore = messages.length - opts.keepRecent;
  if (messages.length <= 2) return { messages, stats };

  // Pair each tool result back to the call that produced it. Providers key this
  // by id, and only the assistant message carries the tool name and arguments.
  const callById = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) callById.set(c.id, c);
  }

  // A read is superseded once the same path is read again later: the newer copy
  // is strictly more current, so the older one is pure re-billed weight. Reads
  // are matched by path only — `read_file` of the same path always returns the
  // file as of that moment, so the last one wins regardless of line range.
  const lastReadOfPath = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    const call = callById.get(m.toolCallId);
    if (call?.name !== 'read_file') return;
    const p = call ? pathOf(call) : null;
    if (p) lastReadOfPath.set(p, i);
  });

  const out = messages.map((m, i) => {
    if (m.role === 'tool') {
      const call = callById.get(m.toolCallId);
      const p = call ? pathOf(call) : null;
      // Supersession runs at any distance: a newer read of the same path is
      // already in this conversation, so the older copy is redundant, not lost.
      if (call?.name === 'read_file' && p && (lastReadOfPath.get(p) ?? -1) > i) {
        const stub = `[superseded: this earlier read of ${p} was replaced by a later read in this conversation. Use the newer one, or call read_file again for the current contents.]`;
        if (stub.length < m.content.length) {
          stats.charsSaved += m.content.length - stub.length;
          stats.superseded++;
          return { ...m, content: stub };
        }
        return m;
      }
      if (i >= truncateBefore) return m; // recent: never clipped
      const capped = clip(
        m.content,
        opts.maxToolResultChars,
        `re-run this tool, or read_file with start_line/end_line, to see the full output`,
      );
      if (capped !== m.content) {
        stats.charsSaved += m.content.length - capped.length;
        stats.truncated++;
        return { ...m, content: capped };
      }
      return m;
    }

    if (m.role === 'assistant' && m.toolCalls?.length && i < truncateBefore) {
      let changed = false;
      const toolCalls = m.toolCalls.map((c) => {
        const args: Record<string, unknown> = {};
        let touched = false;
        for (const [k, v] of Object.entries(c.args ?? {})) {
          if (typeof v === 'string' && v.length > opts.maxToolArgChars) {
            // This call already executed; its effect is on disk. Restating the
            // whole payload every later turn buys nothing.
            const capped = clip(v, opts.maxToolArgChars, `already applied by this call`);
            stats.charsSaved += v.length - capped.length;
            stats.truncated++;
            args[k] = capped;
            touched = true;
          } else {
            args[k] = v;
          }
        }
        if (!touched) return c;
        changed = true;
        return { ...c, args };
      });
      return changed ? { ...m, toolCalls } : m;
    }

    return m;
  });

  return { messages: out, stats };
}
