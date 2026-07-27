# REPL UI layout spec

Captured from a real run (pty + VT102 emulator, 100x30). This file is the
editing surface for the interactive shell's chrome: change any line below,
paste it back, and the implementation follows. Every visual token maps to one
function in `src/agent/theme.ts`, so color changes are one-line edits.

## State 1: idle prompt

```text
 1|                                                                        <- blank
 2|   ▄▟▙▄       copperhead v0.7.0                                         <- mark[copper]  name[bold] version[dim]
 3| ███  ███     claude via flag · kicad-cli 9.0.4                         <- mark[copper]  meta[dim]
 4|   ▀▜▛▀       ~/Github/chouhan-industries/copperhead                    <- mark[copper]  cwd[dim]
 5|                                                                        <- blank
 6| ▎ New repository?                                                      <- bar[copper] title[copper]
 7| ▎  `copperhead init` scaffolds docs/ from an existing schematic        <- bar[copper] body[default]
 8| ▎  `copperhead demo` runs the USB-C breakout create pipeline           <- bar[copper] body[default]
 9| ▎ Docs: https://docs.copperhead.sh                                     <- bar[copper] body[copper]
10|                                                                        <- content region: echoes + agent
..|  ❯ rename net KEY_DAH to KEY_DASH                                      <-   output scroll here, oldest
..|  ▸ run_erc  clean — 0 violations                                       <-   scrolls off the top
26|                                                     ● claude · main*   <- meta right-aligned: dot[copper] text[dim]
27|──────────────────────────────────────────────────────────────────────  <- rule[dim], full width
28|❯ Try "add reverse-polarity protection on VIN"                          <- prompt[copper]+nbsp, caret = real cursor, placeholder[dim] typed[bright]
29|──────────────────────────────────────────────────────────────────────  <- rule[dim], full width
30|  / for commands · pgup history · ctrl+c twice to quit         In copperhead   <- left[dim]  right[dim]
```

## State 2: slash menu open (overlays upward, input row never moves)

```text
16|  ❯ /demo         what copperhead does + how to try it                  <- hovered: ❯[copper] label+desc[copperLight], desc wraps to a 2nd row
17|    /examples     example change-request prompts                        <- label[default] desc[default]
..|    ...up to 10 items...
26|  ↓ 10 more                                                             <- overflow marker[dim]
27|──────────────────────────────────────────────────────────────────────  <- rule[dim]
28|❯ /                                                                     <- typed filter[bright]
29|──────────────────────────────────────────────────────────────────────  <- rule[dim]
30|  / for commands · pgup history · ctrl+c twice to quit         In copperhead
```

## State 3: agent turn running (observability row pinned in the dock)

```text
26|                                                     ● claude · main*   <- meta stays
27|──────────────────────────────────────────────────────────────────────
28|⠹ Reflowing...              turn 2/40 · 1.2k in / 300 out · 12s · ERC   <- word left[copper], stats right[dim] busy[warn]
29|──────────────────────────────────────────────────────────────────────
30|  ctrl+c interrupts the run · output above scrolls into history
```

The working word is a PCB term (Routing, Etching, Reflowing, Soldering,
Drilling, Plating, Probing, Fluxing, Tinning, Laminating, Silkscreening,
Panelizing), one per turn, with animated dots: Claude Code's working verbs,
board-shop edition; on rotation the old word crossfades char by char
through `_` slots, dots included. Durable output (tool lines, turn markers, the outcome)
scrolls in the content region; the observability row never moves. Between
submit and the first turn a passive `… working` row shows briefly.

First Ctrl+C at the prompt: input clears, row 30 becomes `press ctrl+c again to exit` [warn].

History: every content line is kept in a session buffer (cap 5000). PgUp at
the prompt scrolls the content region back through it (arrow keys / mouse
wheel line-scroll too at an empty prompt), PgDn scrolls forward,
any other key snaps back to the live tail; row 30 shows
`history ↑N · pgup/pgdn scroll · any key returns` while scrolled. The same
lines are mirrored by default to `.copperhead/runs/repl-<timestamp>.log`
(plain text: SGR stripped, `sk-` keys redacted per AC-4.1); the path is
printed when the session ends. Injected loggers (tests/embeds) disable the
file sink.

Startup: the full screen loads instantly (banner, callout, input dock), then
the mark pulses in place twice over rows 2-4 (dot, thin ring, thick
ring, full via) while the prompt is already usable. First run in a repo (no
`.copperhead/` yet) uses slow timing (110ms/frame) and shows the New
repository callout; later runs pulse fast (45ms/frame) and hide it.

## Color tokens (src/agent/theme.ts)

| Token         | SGR                | Current value             | Used for                               |
| ------------- | ------------------ | ------------------------- | -------------------------------------- |
| `copper`      | `38;2;184;115;51`  | #b87333 (brand: #b87333)  | mark, prompt ❯, callout bar, meta dot  |
| `copperLight` | `38;2;238;201;165` | #eec9a5 (accent-high)     | hovered menu row                       |
| `bold`        | `1`                | bold, default fg          | `copperhead` name (theme-adaptive)     |
| `bright`      | `97`               | white                     | typed input text                       |
| `dim`         | `38;2;153;153;153` | #999999 (SGR 90 fallback) | hints, placeholder, version, paths     |
| `ruleDim`     | `38;2;136;136;136` | #888888 (SGR 90 fallback) | input-area rules                       |
| `ok`          | `32`               | green                     | success lines (`check: all green`)     |
| `warn`        | `33`               | amber                     | ctrl+c hint, cautions                  |
| `err`         | `31`               | red                       | failures                               |

Note: `copper` is the exact brand #b87333 on truecolor terminals
(COLORTERM=truecolor/24bit); terminals without truecolor fall back to
256-color 173. See [claude-ui-layout.md](claude-ui-layout.md) for the measured
Claude Code reference palette to diff against.

## Region -> source map

| Region                | Source                                          |
| --------------------- | ----------------------------------------------- |
| Banner + callout      | `banner()` in `src/commands/repl.ts`            |
| Meta line, status bar | `ask()` options in `src/commands/repl.ts`       |
| Input rows, menu      | `src/util/live-prompt.ts` (`renderDock`)        |
| Rules, callout, bars  | `src/agent/box.ts`                              |
| Screen ownership      | `src/util/dock.ts` (alt screen + DECSTBM fence) |

To iterate: edit the annotated lines above (text, alignment, or `[token]`
tags), paste the block back, and the code gets updated to match. Verify with
`npm run demo:ui` (see below).

## Demo recording (npm run demo:ui)

`npm run demo:ui` from the repo root runs `scripts/ui-demo.ts` via tsx: the
real REPL UI with a canned agent run, no build step, no API key, no repo
mutations. Same script every take, so recordings are reproducible.

Standard take:

1. Let the banner settle and the via mark pulse
2. Type `/`, hover a few commands with the arrow keys, Esc to dismiss
3. Type `rename net KEY_DAH to KEY_DASH`, Enter, let the mock run play
   (~17s, four sections: propose, edit, verify, remember, each closed by a
   summary line; the pinned observability row animates and the working word
   morphs at each section)
4. `/check` for the mock green ERC/DRC/drift pass
5. Ctrl+C twice to exit

The demo uses the current directory as the repo. A directory that already has
`.copperhead/` gets the fast mark pulse and no callout; for the full
first-run intro (slow pulse + New repository callout), run from a fresh
directory:

```bash
cd $(mktemp -d) && node <repo>/node_modules/.bin/tsx <repo>/scripts/ui-demo.ts
```

The mark itself can be regenerated from the website logo geometry at any
size with `node scripts/gen-logo.mjs <rows>`.
