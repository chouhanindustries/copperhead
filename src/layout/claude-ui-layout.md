# Claude Code UI layout (measured reference)

Captured from the real `claude` CLI (v2.1.220) under a pty + VT102 emulator at
100x30, with per-cell SGR attributes extracted, so every color below is
measured, not eyeballed. This is the reference to diff
[repl-ui-layout.md](repl-ui-layout.md) against when editing copperhead's
chrome.

## State 1: idle prompt

```text
 2| ▐▛███▜▌   Claude Code v2.1.220                       <- logo[#d77757]  name[bold, default fg] version[#999999]
 3|▝▜█████▛▘  Fable 5 with high effort · Claude Max      <- logo[#d77757]  model+plan[#999999]
 4|  ▘▘ ▝▝    ~/Github/chouhan-industries/copperhead     <- logo[#d77757]  cwd[#999999]
 5|
 6|   Tackle your toughest work with Opus 5. ...          <- notice body[default fg]
 7|   +1 more · /status                                   <- [#999999]
..|                                                       <- content region, output scrolls here
25|                                     ● high · /effort  <- meta right-aligned, all [#999999]
26|─────────────────────────────────────────────────────  <- rule[#888888], full width
27|❯ Try "create a util logging.py that..."               <- ❯ + nbsp[default], placeholder[faint], caret = real cursor
28|─────────────────────────────────────────────────────  <- rule[#888888], full width
29|  ⚠ Transcript saving is off · ...                     <- warning line (only when present)
30|  ⏸ manual mode on · ? for shortcuts                   <- status left[#999999]
```

## State 2: slash menu open (upward overlay, input row fixed at 27)

```text
22|  /pr-review     Review a copperhead pull request...   <- hovered: label+desc[#b1b9f9], no inverse video
23|                 spec workflow. Use when the user...   <- description wraps to a second row
24|  /review        Review a GitHub pull request; ...     <- unhovered: [#999999]
26|─────────────────────────────────────────────────────
27|❯ /                                                    <- typed filter[default fg]
28|─────────────────────────────────────────────────────
30|  ⏸ manual mode on                                     <- status shrinks while menu is open
```

## State 3: Ctrl+C pressed once

```text
30|  Press Ctrl-C again to exit                           <- [#999999], replaces the status line
```

## Measured color palette

| Role                        | Value             | Notes                                   |
| --------------------------- | ----------------- | --------------------------------------- |
| Accent (logo)               | `#d77757`         | truecolor; the only saturated color     |
| Title (`Claude Code`)       | bold, default fg  | not white-forced: follows the theme     |
| Secondary text              | `#999999`         | truecolor gray, softer than SGR 90      |
| Rules                       | `#888888`         | one step darker than secondary text     |
| Menu hover                  | `#b1b9f9`         | periwinkle, hover is a color change     |
| Placeholder                 | faint (SGR 2)     | not fg-colored, uses the faint attr     |
| Caret                       | terminal cursor   | real cursor, not a synthetic inverse    |

## Structural notes vs copperhead's current implementation

1. Grays: adopted. copperhead's `dim`/`ruleDim` are truecolor
   `#999999`/`#888888` (with an SGR 90 fallback when truecolor is off).
2. Menu hover: adopted as a color change. Claude recolors the row with
   periwinkle `#b1b9f9`; copperhead recolors with `copperLight` (#eec9a5)
   instead of inverse video.
3. Hovered menu descriptions: adopted. Both wrap to a second row.
4. Caret: adopted. copperhead parks the real terminal cursor in the input
   row instead of drawing a synthetic inverse block.
5. The name `Claude Code` is bold in the terminal's default foreground, so it
   adapts to light/dark themes, it is not hard-coded white.
6. There is a non-breaking space after `❯` in the prompt.

To adopt any of these in copperhead, edit the corresponding line in
[repl-ui-layout.md](repl-ui-layout.md) and paste it back.
