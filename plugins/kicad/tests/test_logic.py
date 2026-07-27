"""Scenario matrix for the pane's wx-free decision logic (AC-114B.5/B.6).

Every branch here corresponds to a behavior that either failed or almost
failed during live bring-up; see logic.py's docstrings for the history.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from copperhead_panel.logic import (  # noqa: E402
    decide_submit,
    hello_status,
    resolve_project_dir,
    should_respawn,
)

HOME = "/fake/home"


class ResolveProjectDir(unittest.TestCase):
    def test_open_board_yields_its_directory(self):
        d, reason = resolve_project_dir(lambda: "/work/boards/keyer/keyer.kicad_pcb", HOME)
        self.assertEqual(d, "/work/boards/keyer")
        self.assertIsNone(reason)

    def test_relative_board_path_is_absolutized(self):
        d, reason = resolve_project_dir(lambda: "keyer.kicad_pcb", HOME)
        self.assertTrue(os.path.isabs(d))
        self.assertIsNone(reason)

    def test_unsaved_board_falls_back_to_home_with_reason(self):
        d, reason = resolve_project_dir(lambda: "", HOME)
        self.assertEqual(d, HOME)
        self.assertIn("no board file", reason)

    def test_none_board_file_is_the_unsaved_case(self):
        d, reason = resolve_project_dir(lambda: None, HOME)
        self.assertEqual(d, HOME)
        self.assertIn("no board file", reason)

    def test_getboard_raising_is_named_in_the_reason(self):
        def boom():
            raise RuntimeError("SWIG object gone")

        d, reason = resolve_project_dir(boom, HOME)
        self.assertEqual(d, HOME)
        self.assertIn("GetBoard failed", reason)
        self.assertIn("SWIG object gone", reason)


class DecideSubmit(unittest.TestCase):
    def args(self, **over):
        base = dict(client_alive=True, run_active=False, current_dir="/p", want_dir="/p")
        base.update(over)
        return base

    def test_empty_and_whitespace_are_ignored(self):
        self.assertEqual(decide_submit("", **self.args()), ("ignore", None))
        self.assertEqual(decide_submit("   ", **self.args()), ("ignore", None))

    def test_dead_client_is_ignored(self):
        self.assertEqual(decide_submit("add LED", **self.args(client_alive=False)), ("ignore", None))

    def test_active_run_is_ignored_single_flight(self):
        self.assertEqual(decide_submit("add LED", **self.args(run_active=True)), ("ignore", None))

    def test_clear_and_cls_clear_locally(self):
        self.assertEqual(decide_submit("/clear", **self.args()), ("clear", None))
        self.assertEqual(decide_submit("/cls", **self.args()), ("clear", None))

    def test_other_slash_input_is_steered_not_run(self):
        action, message = decide_submit("/help", **self.args())
        self.assertEqual(action, "steer")
        self.assertIn("/help", message)
        self.assertIn("REPL", message)
        self.assertEqual(decide_submit("/", **self.args())[0], "steer")

    def test_project_change_switches_and_names_the_new_dir(self):
        action, arg = decide_submit("add LED", **self.args(want_dir="/other"))
        self.assertEqual(action, "switch")
        self.assertEqual(arg, "/other")

    def test_same_project_sends_trimmed_text(self):
        self.assertEqual(decide_submit("  add LED  ", **self.args()), ("send", "add LED"))

    def test_slash_precedence_over_project_switch(self):
        # A slash command must never trigger a serve restart.
        self.assertEqual(decide_submit("/clear", **self.args(want_dir="/other")), ("clear", None))


class RespawnBudget(unittest.TestCase):
    def test_respawns_up_to_the_cap_then_gives_up(self):
        self.assertTrue(should_respawn(1))
        self.assertTrue(should_respawn(2))
        self.assertTrue(should_respawn(3))
        self.assertFalse(should_respawn(4))

    def test_custom_cap(self):
        self.assertTrue(should_respawn(1, cap=1))
        self.assertFalse(should_respawn(2, cap=1))


class HelloStatus(unittest.TestCase):
    def test_healthy_hello_shows_model_and_repo(self):
        label, healthy = hello_status({"model": "claude-code", "repoRoot": "/p"})
        self.assertEqual(label, "claude-code · /p")
        self.assertTrue(healthy)

    def test_null_model_is_a_visible_degraded_state(self):
        label, healthy = hello_status({"model": None, "repoRoot": "/p"})
        self.assertEqual(label, "no model configured · /p")
        self.assertFalse(healthy)

    def test_missing_fields_and_none_payload(self):
        label, healthy = hello_status({})
        self.assertEqual(label, "no model configured · ?")
        self.assertFalse(healthy)
        self.assertEqual(hello_status(None)[0], "no model configured · ?")


if __name__ == "__main__":
    unittest.main()
