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
        try:
            import pcbnew

            board_file = pcbnew.GetBoard().GetFileName()
            if board_file:
                return os.path.dirname(os.path.abspath(board_file))
        except Exception:
            pass
        return os.path.expanduser("~")

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
        self.client = ServeClient(
            cli,
            self._project_dir(),
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
            data = obj.get("data", {})
            self.status.SetLabel(
                "%s · %s" % (data.get("model", "?"), data.get("repoRoot", "?"))
            )
            self.status.SetForegroundColour(COPPER)
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
        if self.restarts > 3:
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
        text = self.input.GetValue().strip()
        if not text or self.client is None or not self.client.alive():
            return
        if self.active_id is not None:
            return  # input is disabled anyway; single flight mirrors serve
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
            pane.Show(not pane.IsShown())
            mgr.Update()
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
        floater.Show(not floater.IsShown())
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
