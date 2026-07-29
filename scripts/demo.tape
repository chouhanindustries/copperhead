# VHS recording of the mock REPL session (scripts/ui-demo.ts) framed as a
# terminal window: rounded corners, window bar, dark margin tile.
# Render: vhs scripts/demo.tape  (needs ttyd + ffmpeg on PATH)

Output demo-runs/copperhead-ui.gif

Set Shell bash
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 20
Set Margin 36
Set MarginFill "#101014"
Set BorderRadius 10
Set WindowBar Rings
Set WindowBarSize 40
Set TypingSpeed 60ms

# Launch the demo off-screen so the GIF opens on the settled banner.
Hide
Type "npm run demo:ui"
Enter
Sleep 3s
Show

Sleep 2s

# Slash-command palette: open, hover a few entries, dismiss.
Type "/"
Sleep 800ms
Down@400ms 3
Sleep 800ms
Escape
Sleep 500ms

# The canned agent run: four sections, ~17s of pinned-row animation.
Type "rename net KEY_DAH to KEY_DASH"
Sleep 600ms
Enter
Sleep 19s

# Scroll the history, then a /check pass.
PageUp
Sleep 700ms
PageUp
Sleep 700ms
PageDown
Sleep 700ms
PageDown
Sleep 600ms
Type "/check"
Sleep 600ms
Enter
Sleep 4s

# Exit: Ctrl+C twice.
Ctrl+C
Sleep 400ms
Ctrl+C
Sleep 1s
