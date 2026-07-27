"""The copperhead pane for pcbnew (AC-114B.5/B.6, design D3).

Docks via wx AUI when the pcbnew frame's manager is reachable, floats
otherwise. All serve I/O arrives from client.py's worker thread and is
marshalled onto the UI thread with wx.CallAfter; nothing here blocks the wx
main loop.
"""

import os

import wx
import wx.aui

from .client import ServeClient, config_path, find_cli
from .logic import decide_submit, hello_status, resolve_project_dir, should_respawn

PANE_NAME = "copperhead"
_state = {"panel": None, "floater": None}

COPPER = wx.Colour(184, 115, 51)
DIM = wx.Colour(128, 128, 128)
OK = wx.Colour(80, 160, 80)
ERR = wx.Colour(200, 80, 80)


def _pcbnew_frame():
    for w in wx.GetTopLevelWindows():
        if w.GetName() == "PcbFrame":
            return w
    return None


class CopperheadPanel(wx.Panel):
    def __init__(self, parent):
        super().__init__(parent)
        self.client = None
        self.active_id = None
        # Consecutive unexpected exits before the panel stops respawning: a
        # serve that dies at startup (no model configured) must become a
        # readable error, not an infinite restart loop.
        self.restarts = 0
        # Request queued across a project-switch serve restart; sent on hello.
        self.pending_request = None
        self._dir_reason = None

        sizer = wx.BoxSizer(wx.VERTICAL)
        self.status = wx.StaticText(self, label="starting…")
        self.status.SetForegroundColour(DIM)
        sizer.Add(self.status, 0, wx.EXPAND | wx.ALL, 4)

        self.log = wx.TextCtrl(self, style=wx.TE_MULTILINE | wx.TE_READONLY | wx.TE_RICH2)
        sizer.Add(self.log, 1, wx.EXPAND | wx.LEFT | wx.RIGHT, 4)

        row = wx.BoxSizer(wx.HORIZONTAL)
        self.input = wx.TextCtrl(self, style=wx.TE_PROCESS_ENTER)
        self.input.SetHint("describe a change, Enter to run")
        self.stop_btn = wx.Button(self, label="Stop", size=wx.Size(56, -1))
        self.stop_btn.Disable()
        row.Add(self.input, 1, wx.EXPAND | wx.RIGHT, 4)
        row.Add(self.stop_btn, 0)
        sizer.Add(row, 0, wx.EXPAND | wx.ALL, 4)
        self.SetSizer(sizer)

        self.input.Bind(wx.EVT_TEXT_ENTER, self._on_submit)
        self.stop_btn.Bind(wx.EVT_BUTTON, self._on_stop)

        self._boot()

    # -- serve lifecycle ---------------------------------------------------

    def _project_dir(self):
        """The open board's directory, or home. `_dir_reason` records why the
        fallback was taken so the boot log can say so instead of silently
        running in the wrong place."""

        def board_file():
            import pcbnew

            board = pcbnew.GetBoard()
            return board.GetFileName() if board is not None else ""

        directory, self._dir_reason = resolve_project_dir(board_file)
        return directory

    def _boot(self):
        cli = find_cli()
        if not cli:
            # Degraded start (AC-114B.6): installable before copperhead is.
            self.status.SetLabel("copperhead CLI not found")
            self.status.SetForegroundColour(ERR)
            self._append(
                "Install copperhead first:\n"
                "  npm install -g copperhead\n"
                "or point the panel at a binary by writing\n"
                '  {"cli": "/path/to/copperhead"}\n'
                "to " + config_path() + "\n"
                "then reopen this panel.\n",
                DIM,
            )
            self.input.Disable()
            return
        project_dir = self._project_dir()
        # Name the exact CLI and cwd: when something misbehaves, "which
        # binary did it actually run" is the first diagnostic question.
        self._append("serve: %s (in %s)\n" % (cli, project_dir), DIM)
        if self._dir_reason:
            self._append("note: %s; running in home instead\n" % self._dir_reason, DIM)
        self.client = ServeClient(
            cli,
            project_dir,
            on_message=lambda obj: wx.CallAfter(self._on_message, obj),
            on_exit=lambda code: wx.CallAfter(self._on_serve_exit, code),
        )
        self.client.start()

    def _restart(self, notice):
        self._append(notice + "\n", DIM)
        self.active_id = None
        self.stop_btn.Disable()
        self.input.Enable()
        self._boot()

    # -- wire events (already on the UI thread) ----------------------------

    def _on_message(self, obj):
        event = obj.get("event")
        if event == "hello":
            self.restarts = 0  # a working serve resets the respawn budget
            label, healthy = hello_status(obj.get("data", {}))
            self.status.SetLabel(label)
            self.status.SetForegroundColour(COPPER if healthy else ERR)
            queued, self.pending_request = self.pending_request, None
            if queued and self.client is not None and self.active_id is None:
                self._send(queued)
            return
        if event == "log":
            self._append(str(obj.get("data", {}).get("line", "")) + "\n", None)
            return
        if "result" in obj and obj.get("id") == self.active_id:
            outcome = obj["result"].get("outcome", obj["result"].get("ok"))
            colour = OK if outcome in ("success", True) else ERR
            self._append("outcome: %s\n" % outcome, colour)
            summary = obj["result"].get("summary")
            if summary:
                self._append(summary + "\n", None)
            self.active_id = None
            self.stop_btn.Disable()
            self.input.Enable()
            self.input.SetFocus()
            return
        if "error" in obj:
            self._append("error: %s\n" % obj["error"].get("message", "?"), ERR)
            if obj.get("id") == self.active_id:
                self.active_id = None
                self.stop_btn.Disable()
                self.input.Enable()

    def _on_serve_exit(self, code):
        if self.client is None:
            return  # deliberate shutdown
        stderr = list(self.client.last_stderr)
        self.restarts += 1
        if not should_respawn(self.restarts):
            self.status.SetLabel("serve keeps exiting (%s)" % code)
            self.status.SetForegroundColour(ERR)
            for line in stderr:
                self._append(line + "\n", ERR)
            self._append("fix the cause (see above), then close and reopen this panel.\n", DIM)
            self.input.Disable()
            self.stop_btn.Disable()
            self.client = None
            self.active_id = None
            return
        if stderr:
            self._append(stderr[-1] + "\n", ERR)
        if self.active_id is not None:
            self._restart("run interrupted (serve exited %s); restarting…" % code)
        else:
            self._restart("serve exited (%s); restarting…" % code)

    # -- user events -------------------------------------------------------

    def _on_submit(self, _evt):
        text = self.input.GetValue()
        alive = self.client is not None and self.client.alive()
        current = self.client.project_dir if self.client is not None else None
        action, arg = decide_submit(
            text,
            client_alive=alive,
            run_active=self.active_id is not None,
            current_dir=current,
            want_dir=self._project_dir(),
        )
        if action == "ignore":
            return
        if action == "clear":
            self.input.SetValue("")
            self.log.SetValue("")
            return
        if action == "steer":
            self.input.SetValue("")
            self._append(arg + "\n", DIM)
            return
        if action == "switch":
            # The board changed under the pane; serve's cwd decides which
            # repo gets edited, so restart it in the new project and queue
            # the request through the hello so nothing is lost.
            self._append("project changed: %s\n" % arg, DIM)
            self.input.SetValue("")
            self.pending_request = text.strip()
            client, self.client = self.client, None
            client.stop()
            self._boot()
            return
        self._send(arg)

    def _send(self, text):
        self._append("\n> %s\n" % text, COPPER)
        self.active_id = self.client.run(text)
        self.input.SetValue("")
        self.input.Disable()
        self.stop_btn.Enable()

    def _on_stop(self, _evt):
        # No cancel on the wire by design: killing the child is the REPL's
        # Ctrl+C; _on_serve_exit restarts it.
        if self.client is not None:
            self.client.stop()

    def retry_boot(self):
        """Re-run CLI discovery on re-show: a docked pane is only hidden by
        its close button, so without this the missing-CLI/dead-serve states
        would persist until pcbnew restarts."""
        if self.client is None:
            self.restarts = 0
            self.input.Enable()
            self._boot()

    def shutdown(self):
        client, self.client = self.client, None
        if client is not None:
            client.stop()

    def _append(self, text, colour):
        if colour is not None:
            self.log.SetDefaultStyle(wx.TextAttr(colour))
        self.log.AppendText(text)
        if colour is not None:
            self.log.SetDefaultStyle(wx.TextAttr())


def toggle_panel():
    """Show/hide the pane; dock when AUI is reachable, float otherwise."""
    frame = _pcbnew_frame()
    mgr = wx.aui.AuiManager.GetManager(frame) if frame is not None else None

    if mgr is not None:
        pane = mgr.GetPane(PANE_NAME)
        if pane.IsOk():
            showing = not pane.IsShown()
            pane.Show(showing)
            mgr.Update()
            panel = _state.get("panel")
            if showing and panel is not None:
                panel.retry_boot()
            return
        panel = CopperheadPanel(frame)
        _state["panel"] = panel
        info = (
            wx.aui.AuiPaneInfo()
            .Name(PANE_NAME)
            .Caption("copperhead")
            .Right()
            .Layer(1)
            .BestSize(wx.Size(380, 600))
            .CloseButton(True)
            .MinimizeButton(False)
        )
        mgr.AddPane(panel, info)
        mgr.Update()
        return

    # Floating fallback (AC-114B.5): AUI lookup failed on this platform.
    floater = _state.get("floater")
    if floater is not None and bool(floater):
        showing = not floater.IsShown()
        floater.Show(showing)
        panel = _state.get("panel")
        if showing and panel is not None:
            panel.retry_boot()
        return
    floater = wx.Frame(frame, title="copperhead", size=wx.Size(420, 640))
    _state["floater"] = floater
    panel = CopperheadPanel(floater)
    _state["panel"] = panel

    def on_close(evt):
        panel.shutdown()
        _state["floater"] = None
        _state["panel"] = None
        evt.Skip()

    floater.Bind(wx.EVT_CLOSE, on_close)
    floater.Show()
