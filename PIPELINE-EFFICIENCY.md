# Making `copperhead create` better & more efficient

Recommendations from driving the create pipeline end-to-end on the `claude-code`
provider (USB-C breakout brief). Grounded in the run logs and transcripts saved
under `pipeline-run-logs/`.

## What the runs actually cost

| stage | wall | turns | out tokens | note |
|---|---|---|---|---|
| spec-seed | 80–243s | 7–21 | 5.4–17.3k | re-ran repeatedly (Issue 1 contract bug) |
| architecture | 97–136s | 4–5 | 5.7–9.7k | |
| part-selection | **632s** | 10 | **40.5k** | slowest; obligation-resolve retries |
| schematic | — | 8+ | 48k+ | one 44k-char turn; edit silently dropped (Issue 4) |

Two whole stages produced *nothing* usable despite "succeeding" (Issues 2 and 4),
and spec-seed re-ran several times for zero progress (Issue 1). Most of the spend
above was waste, not work.

## Highest-leverage changes

**1. Stop re-sending the whole conversation every turn (biggest token win).**
The claude-code provider spawns a fresh SDK subprocess per turn (`maxTurns: 1`)
and flattens the *entire* prior conversation into the prompt each time
(`renderConversation`). Cost grows ~quadratically in turns — part-selection's
40k output tokens over 10 turns is mostly re-billed history. Use the Agent SDK's
session resume (or Anthropic prompt caching on the flattened prefix) so earlier
turns aren't re-sent/re-billed. This alone should cut long-stage cost several-fold.

**2. Fewer, richer turns — now unblocked.** The Issue 4 fix (advertise all tools,
gate at dispatch) lets the model do `propose → validate → edit → run_erc →
finish` in a *single* reply instead of one-tool-per-turn. Each turn is a process
spawn + full-context resend, so collapsing 5 turns into 1 is a direct win. Worth
saying "batch independent calls in one reply" more forcefully in the stage prompts.

**3. Never silently drop a tool call.** The two most expensive failures (Issues 2
and 4) were *silent* drops: a well-formed call parsed to nothing, no error came
back, and the model "verified" against an unchanged file and finished. Any reply
that names a known tool but is malformed / locked / not-yet-unlocked should return
a tool-result error, never be discarded as prose. Fixed for the two observed
cases; worth generalizing as an invariant ("a tool-shaped block always produces a
tool result").

**4. Make gates reflect the stage's real goal.** An empty schematic passes ERC
(0 violations) and empty-sheet drift (bootstrap-clean), so the model got a green
light on nothing. `run_erc` should warn on a zero-symbol schematic; stage
contracts should assert the artifact exists (as the symbols>0 check already does).
Gates that can be satisfied by the empty starting state give false confidence.

**5. Tolerant completion contracts.** Issue 1 was a literal `includes('## Budgets')`
that a valid `## 3. Budgets and constraints` heading failed forever. Contract
matchers should be structural (heading-aware, artifact-presence), never exact
string matches against model-authored prose.

## Reliability / ergonomics

**6. Per-turn watchdog.** A single SDK turn can run for minutes (a 44k-char turn
looked indistinguishable from a hang). There's no timeout, so a genuinely hung
subprocess stalls the run forever. Add a per-turn deadline that retries/fails.

**7. Obligation resolution is fiddly.** `resolve_affected` exact-matches on a
constraint identifier the model has to reproduce verbatim; the logs show many
`no open affects-revisit obligation matches "..."` retries burning turns. Return
the list of open obligation keys in the error, or match fuzzily on the echoed key.

**8. Incremental schematic capture.** The model wrote the whole schematic in one
9kB+ `edit_file` — atomic, so one escaping/geometry error loses everything and
there's no partial feedback. Prompt for symbol-by-symbol capture with `run_erc`
after each part, so failures are local and the KiCad load-probe gives tight
feedback loops. (KiCad quirk worth teaching in-prompt: a label on a pin names the
net but does **not** count as a connection without a wire — the run wasted an ERC
cycle rediscovering this.)

**9. Trim the empty-args first call.** The model routinely opens with
`{"tool":"read_file"}` (no args) and eats an error+turn. A one-line protocol note
("always include a populated `args` object") removes a wasted round-trip per stage.
