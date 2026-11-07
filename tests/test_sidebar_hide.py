import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jsrun import run_js  # noqa: E402


def free_key(table, key):
    return run_js("05-bootstrap.js", "window.__vm.bootstrap.freeKey(table, key)", table=table, key=key)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the profile setup's JavaScript")
class FreeTheKey(unittest.TestCase):
    """Ctrl+S is Vivarc's (it hides this window's sidebar), so setup takes it off every Vivaldi command that holds it."""

    TABLE = {
        "COMMAND_MAIN_TOGGLE_TAB_BAR": {"shortcuts": ["ctrl+s"]},
        "COMMAND_TOGGLE_AUTO_HIDE_TAB_BAR": {"shortcuts": ["f4", "ctrl+s"]},
        "COMMAND_SAVE_PAGE": {"shortcuts": []},
        "COMMAND_NEW_TAB": {"shortcuts": ["ctrl+shift+s", "f9"]},
        "COMMAND_PAGE_BACK": {"shortcuts": ["alt+left"], "gestures": ["0"]},
    }

    def test_every_command_holding_the_key_loses_it_and_is_named(self):
        out = free_key(self.TABLE, "ctrl+s")
        self.assertEqual(out["freed"], ["COMMAND_MAIN_TOGGLE_TAB_BAR", "COMMAND_TOGGLE_AUTO_HIDE_TAB_BAR"])
        self.assertEqual(out["table"]["COMMAND_MAIN_TOGGLE_TAB_BAR"]["shortcuts"], [])
        self.assertEqual(out["table"]["COMMAND_TOGGLE_AUTO_HIDE_TAB_BAR"]["shortcuts"], ["f4"])

    def test_nothing_else_changes(self):
        out = free_key(self.TABLE, "ctrl+s")["table"]
        for name in ("COMMAND_SAVE_PAGE", "COMMAND_NEW_TAB", "COMMAND_PAGE_BACK"):
            self.assertEqual(out[name], self.TABLE[name])  # a similar combo (ctrl+shift+s) and other fields stay

    def test_the_input_table_is_not_modified(self):
        before = {k: dict(v) for k, v in self.TABLE.items()}
        free_key(self.TABLE, "ctrl+s")
        self.assertEqual(self.TABLE, before)

    def test_running_it_again_changes_nothing(self):
        once = free_key(self.TABLE, "ctrl+s")
        twice = free_key(once["table"], "ctrl+s")
        self.assertEqual(twice["freed"], [])
        self.assertEqual(twice["table"], once["table"])

    def test_the_key_is_matched_however_it_is_written(self):
        out = free_key({"A": {"shortcuts": ["Ctrl+S"]}, "B": {"shortcuts": ["shift+ctrl+s"]}}, "ctrl+s")
        self.assertEqual(out["freed"], ["A"])

    def test_on_a_mac_the_key_is_cmd_s(self):
        out = free_key({"COMMAND_TOGGLE_AUTO_HIDE_TAB_BAR": {"shortcuts": ["meta+s"]}}, "meta+s")
        self.assertEqual(out["freed"], ["COMMAND_TOGGLE_AUTO_HIDE_TAB_BAR"])

    def test_odd_entries_are_left_alone_rather_than_an_error(self):
        table = {"A": None, "B": {}, "C": {"shortcuts": "ctrl+s"}, "D": {"shortcuts": [None, 3, "ctrl+s"]}}
        out = free_key(table, "ctrl+s")
        self.assertEqual(out["freed"], ["D"])
        self.assertEqual(out["table"]["D"]["shortcuts"], [None, 3])
        self.assertEqual(out["table"]["C"], {"shortcuts": "ctrl+s"})


def pressed_here(event, own, focused):
    return run_js("12-sidebar-hide.js", "window.__vm.sidebarHide.pressedHere(event, own, focused)", event=event, own=own, focused=focused)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar hide's JavaScript")
class PressedHere(unittest.TestCase):
    """Every window's listener hears every key, so a window acts only on a key pressed in it: the window id in the event
    is compared with its own; without ids it falls back to being the focused window."""

    def test_the_window_the_key_was_pressed_in_acts(self):
        self.assertTrue(pressed_here(7, 7, False))

    def test_every_other_window_ignores_it_even_when_it_says_it_is_focused(self):
        self.assertFalse(pressed_here(7, 8, True))

    def test_without_an_id_in_the_event_or_for_the_window_the_focused_window_acts(self):
        for event, own in ((None, 7), (7, None), (None, None)):
            self.assertTrue(pressed_here(event, own, True), (event, own))
            self.assertFalse(pressed_here(event, own, False), (event, own))


if __name__ == "__main__":
    unittest.main()
