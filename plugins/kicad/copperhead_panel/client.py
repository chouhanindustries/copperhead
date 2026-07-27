"""NDJSON child-process client for `copperhead serve` (AC-114B, design D3/D4).

All protocol logic lives here so the wx code in panel.py stays layout-only.
No dependencies beyond the standard library: this runs inside KiCad's
bundled Python.
"""

import json
import os
import shutil
import subprocess
import threading


def _settings_dir():
    """KiCad's user settings dir when available, else a stable fallback."""
    try:
        import pcbnew  # noqa: F401  (only importable inside KiCad)

        return pcbnew.SETTINGS_MANAGER.GetUserSettingsPath()
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".config", "kicad")


def config_path():
    return os.path.join(_settings_dir(), "copperhead_panel.json")


def find_cli(config_file=None, which=shutil.which):
    """Locate the copperhead CLI: config file first, then PATH (D4).

    Returns the executable path, or None (the panel renders an install hint).
    The parameters exist for tests; production callers pass nothing.
    """
    try:
        with open(config_file or config_path(), "r", encoding="utf-8") as fh:
            configured = json.load(fh).get("cli")
        if configured and os.path.exists(configured):
            return configured
    except Exception:
        pass
    return which("copperhead")


class ServeClient:
    """Owns one `copperhead serve` child: spawn, NDJSON I/O, reader thread.

    `on_message(obj)` and `on_exit(code)` are called from a worker thread;
    the panel marshals to the UI thread (wx.CallAfter) itself, keeping this
    module wx-free and importable anywhere (AC-114B.5).
    """

    def __init__(self, cli, project_dir, on_message, on_exit):
        self.cli = cli
        self.project_dir = project_dir
        self.on_message = on_message
        self.on_exit = on_exit
        self.proc = None
        self._reader = None
        self._next_id = 0
        # Last few stderr lines: when serve dies at startup (no model
        # configured, broken install) this is the only diagnosis there is,
        # so the panel surfaces it with the exit notice.
        self.last_stderr = []

    def start(self):
        # Forward the whole environment: KiCad sets KICAD_API_SOCKET and
        # KICAD_API_TOKEN for plugin processes, which is exactly what serve's
        # Phase A bridge discovery prefers (AC-114B.6).
        self.proc = subprocess.Popen(
            [self.cli, "serve"],
            cwd=self.project_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=dict(os.environ),
        )
        threading.Thread(target=self._stderr_loop, args=(self.proc,), daemon=True).start()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _stderr_loop(self, proc):
        try:
            for line in proc.stderr:
                line = line.strip()
                if line:
                    self.last_stderr = (self.last_stderr + [line])[-5:]
        except Exception:
            pass

    def _read_loop(self):
        proc = self.proc
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue  # tolerate a torn line; serve redacts, we never crash
                self.on_message(obj)
        finally:
            code = proc.wait() if proc else -1
            self.on_exit(code)

    def request(self, method, params=None):
        """Send one request; returns its id (string)."""
        self._next_id += 1
        rid = str(self._next_id)
        msg = {"id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        return rid

    def run(self, request_text):
        return self.request("run", {"request": request_text})

    def check(self):
        return self.request("check")

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self):
        """Kill the child (the REPL Ctrl+C equivalent; there is no cancel
        method in the protocol by design)."""
        if self.proc is None:
            return
        try:
            self.proc.kill()
        except Exception:
            pass
