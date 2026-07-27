"""ServeClient and CLI discovery against a real child process (fake serve).

Covers the process-facing behaviors the pane depends on: discovery order,
NDJSON framing both ways, torn-line tolerance, environment forwarding,
cwd, stderr capture, exit reporting, and kill semantics.
"""

import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from copperhead_panel.client import ServeClient, find_cli  # noqa: E402

FAKE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_serve.py")


def make_shim(tmp, mode="normal"):
    """An executable that runs fake_serve.py with the chosen failure mode."""
    path = os.path.join(tmp, "copperhead-fake")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(
            "#!/bin/sh\nCOPPERHEAD_FAKE_MODE=%s exec %s %s \"$@\"\n" % (mode, sys.executable, FAKE)
        )
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


class Session:
    """Collects client callbacks with a wait helper (worker-thread safe)."""

    def __init__(self, tmp, mode="normal", project_dir=None):
        self.messages = []
        self.exits = []
        self._event = threading.Event()
        self.client = ServeClient(
            make_shim(tmp, mode),
            project_dir or tmp,
            on_message=self._on_message,
            on_exit=self._on_exit,
        )
        self.client.start()

    def _on_message(self, obj):
        self.messages.append(obj)
        self._event.set()

    def _on_exit(self, code):
        self.exits.append(code)
        self._event.set()

    def wait_for(self, pred, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            self._event.wait(0.05)
            self._event.clear()
        return False


class FindCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="copperhead-clitest-")

    def write_config(self, payload):
        path = os.path.join(self.tmp, "copperhead_panel.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(payload)
        return path

    def test_config_file_wins_over_path(self):
        shim = make_shim(self.tmp)
        cfg = self.write_config(json.dumps({"cli": shim}))
        self.assertEqual(find_cli(cfg, which=lambda _: "/from/path"), shim)

    def test_config_pointing_at_a_missing_binary_falls_back_to_path(self):
        cfg = self.write_config(json.dumps({"cli": os.path.join(self.tmp, "gone")}))
        self.assertEqual(find_cli(cfg, which=lambda _: "/from/path"), "/from/path")

    def test_invalid_config_json_falls_back_to_path(self):
        cfg = self.write_config("{not json")
        self.assertEqual(find_cli(cfg, which=lambda _: "/from/path"), "/from/path")

    def test_absent_config_file_falls_back_to_path(self):
        missing = os.path.join(self.tmp, "nope.json")
        self.assertEqual(find_cli(missing, which=lambda _: "/from/path"), "/from/path")

    def test_nothing_found_returns_none_for_the_install_hint(self):
        missing = os.path.join(self.tmp, "nope.json")
        self.assertIsNone(find_cli(missing, which=lambda _: None))


class ServeClientBehavior(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="copperhead-clienttest-")

    def hello_of(self, s):
        return next(m for m in s.messages if m.get("event") == "hello")

    def test_hello_carries_cwd_and_forwarded_environment(self):
        os.environ["COPPERHEAD_TEST_MARKER"] = "forwarded-123"
        try:
            s = Session(self.tmp, project_dir=self.tmp)
            self.assertTrue(s.wait_for(lambda: any(m.get("event") == "hello" for m in s.messages)))
            data = self.hello_of(s)["data"]
            # cwd = the project dir the pane chose (AC-114B.6)
            self.assertEqual(os.path.realpath(data["repoRoot"]), os.path.realpath(self.tmp))
            # env forwarded (how KICAD_API_SOCKET/TOKEN reach serve)
            self.assertEqual(data["marker"], "forwarded-123")
        finally:
            del os.environ["COPPERHEAD_TEST_MARKER"]
        s.client.stop()

    def test_requests_are_ndjson_with_incrementing_ids_and_replies_arrive(self):
        s = Session(self.tmp)
        self.assertTrue(s.wait_for(lambda: any(m.get("event") == "hello" for m in s.messages)))
        rid1 = s.client.run("add an LED")
        rid2_holder = []
        self.assertTrue(s.wait_for(lambda: any("result" in m and m.get("id") == rid1 for m in s.messages)))
        rid2_holder.append(s.client.check())
        self.assertTrue(
            s.wait_for(lambda: any("result" in m and m.get("id") == rid2_holder[0] for m in s.messages))
        )
        self.assertEqual((rid1, rid2_holder[0]), ("1", "2"))
        run_msgs = [m for m in s.messages if m.get("id") == rid1]
        self.assertEqual(run_msgs[0]["event"], "log")  # stream precedes result
        self.assertEqual(run_msgs[-1]["result"]["summary"], "add an LED")
        s.client.stop()

    def test_torn_output_lines_are_dropped_not_fatal(self):
        s = Session(self.tmp, mode="garbage")
        self.assertTrue(s.wait_for(lambda: any(m.get("event") == "hello" for m in s.messages)))
        rid = s.client.run("still works")
        self.assertTrue(s.wait_for(lambda: any("result" in m and m.get("id") == rid for m in s.messages)))
        s.client.stop()

    def test_child_exit_reports_the_code(self):
        s = Session(self.tmp, mode="die")
        self.assertTrue(s.wait_for(lambda: bool(s.exits)))
        self.assertEqual(s.exits, [7])
        self.assertFalse(s.client.alive())

    def test_stderr_keeps_the_last_five_lines(self):
        s = Session(self.tmp, mode="stderr")
        self.assertTrue(s.wait_for(lambda: bool(s.exits)))
        self.assertEqual(s.exits, [3])
        self.assertTrue(s.wait_for(lambda: len(s.client.last_stderr) == 5))
        self.assertEqual(
            s.client.last_stderr, ["stderr line %d" % i for i in range(3, 8)]
        )

    def test_stop_kills_and_reports_exit(self):
        s = Session(self.tmp)
        self.assertTrue(s.wait_for(lambda: any(m.get("event") == "hello" for m in s.messages)))
        self.assertTrue(s.client.alive())
        s.client.stop()
        self.assertTrue(s.wait_for(lambda: bool(s.exits)))
        self.assertFalse(s.client.alive())


if __name__ == "__main__":
    unittest.main()
