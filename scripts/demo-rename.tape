# Rename-only cut of the mock REPL session: banner, one request, the four
# pipeline sections, done. Colored window-bar dots on a distinct bar.
# The bar color needs the locally patched vhs build (env var override):
#   VHS_WINDOW_BAR_COLOR="#22222a" vhs scripts/demo-rename.tape

Output demo-runs/copperhead-rename.gif

Set Shell bash
# Default vhs theme with a darker gray background.
Set Theme { "background": "#0f0f11", "foreground": "#dddddd", "cursor": "#dddddd", "cursorAccent": "#0f0f11", "black": "#282a2e", "brightBlack": "#4d4d4d", "red": "#D74E6F", "brightRed": "#FE5F86", "green": "#31BB71", "brightGreen": "#00D787", "yellow": "#D3E561", "brightYellow": "#EBFF71", "blue": "#8056FF", "brightBlue": "#9B79FF", "magenta": "#ED61D7", "brightMagenta": "#FF7AEA", "cyan": "#04D7D7", "brightCyan": "#00FEFE", "white": "#bfbfbf", "brightWhite": "#e6e6e6" }
Set FontSize 20
# 80 cols x 24 rows inside the window at FontSize 20.
Set Width 1072
Set Height 760
Set Padding 16
Set Margin 40
Set MarginFill "demo-runs/martin-martz-qqyUN78RmgI-unsplash.jpg"
Set BorderRadius 10
Set WindowBar Colorful
Set WindowBarSize 40
Set TypingSpeed 60ms

# Launch the demo off-screen so the GIF opens on the settled banner.
Hide
Type "npm run demo:ui"
Enter
Sleep 3s
Show

Sleep 1.5s

# The canned agent run: four sections, ~17s of pinned-row animation.
Type "rename net KEY_DAH to KEY_DASH"
Sleep 600ms
Enter
Sleep 20s

# Hold on the finished run before the GIF loops.
Sleep 2s
