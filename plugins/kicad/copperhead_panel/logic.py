"""wx-free decision logic for the copperhead pane (AC-114B.5/B.6).

Every behavior that burned us during live bring-up lives here as a pure
function, so the full scenario matrix runs in plain unittest with no wx and
no pcbnew (see plugins/kicad/tests/). panel.py stays a thin adapter that
maps these decisions onto widgets.
"""

import os

# Consecutive unexpected serve exits tolerated before the pane gives up
# instead of respawning (a serve that dies at startup must become a
# readable error, not an infinite restart loop).
RESTART_CAP = 3


def resolve_project_dir(get_board_file, home=None):
    """Where serve should run: the open board's directory when there is one.

    `get_board_file` is a callable returning the board's file path ("" when
    the board is unsaved); it may raise (pcbnew API quirk). Returns
    (directory, reason): reason is None on the happy path and a
    human-readable explanation whenever the home fallback was taken, so the
    pane can say why instead of silently running in the wrong place.
    """
    home = home or os.path.expanduser("~")
    try:
        board_file = get_board_file() or ""
    except Exception as exc:
        return home, "GetBoard failed: %s" % exc
    if board_file:
        return os.path.dirname(os.path.abspath(board_file)), None
    return home, "no board file is open (unsaved board?)"


def decide_submit(text, client_alive, run_active, current_dir, want_dir):
    """What one submitted input line should do.

    Returns one of:
      ("ignore", None)          empty input, dead client, or a run in flight
      ("clear", None)           /clear · /cls: wipe the pane log locally
      ("steer", message)        other slash input: never burn a run on it
      ("switch", want_dir)      board moved: restart serve there, queue text
      ("send", text)            normal request on the current project
    """
    text = (text or "").strip()
    if not text or not client_alive or run_active:
        return ("ignore", None)
    if text.startswith("/"):
        if text in ("/clear", "/cls"):
            return ("clear", None)
        return (
            "steer",
            "%s: slash commands live in the terminal REPL; this pane runs change requests" % text,
        )
    if current_dir is not None and want_dir != current_dir:
        return ("switch", want_dir)
    return ("send", text)


def should_respawn(consecutive_exits, cap=RESTART_CAP):
    """True while an unexpectedly-exited serve should be restarted; a
    successful hello resets the caller's counter."""
    return consecutive_exits <= cap


def hello_status(data):
    """Status-row content from a hello payload: (label, healthy).

    A null model is a working serve in a degraded state (runs will fail
    with no-model errors); the row must say so rather than showing "?".
    """
    data = data or {}
    model = data.get("model")
    label = "%s · %s" % (model or "no model configured", data.get("repoRoot", "?"))
    return label, bool(model)
