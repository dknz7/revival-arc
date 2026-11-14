"""Back closes a tab a link opened (17-back-closes.js): when, and only when, Back on it would do nothing today."""
import json
import os
import re
import shutil
import unittest

from jsrun import run_js


def ext(space):
    return json.dumps({"workspaceId": space} if space else {})


TAB = {"id": 2, "windowId": 1, "active": True, "vivExtData": ext(11)}
OPENER = {"id": 1, "windowId": 1, "active": False, "vivExtData": ext(11)}


def should_close(tab=TAB, opener=OPENER, can_go_back=False, shown=11, kept=False, on=True):
    return run_js("17-back-closes.js", "window.__vm.back.shouldClose({ on, tab, opener, canGoBack, shown, kept })", tab=tab, opener=opener,
                  canGoBack=can_go_back, shown=shown, kept=kept, on=on)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Back behaviour's JavaScript")
class Eligible(unittest.TestCase):
    def test_a_tab_a_link_opened_with_no_history_closes(self):
        self.assertTrue(should_close())

    def test_off_by_default_does_nothing(self):
        self.assertFalse(should_close(on=False))

    def test_a_tab_that_can_go_back_goes_back(self):
        self.assertFalse(should_close(can_go_back=True))

    def test_history_not_known_closes_nothing(self):
        self.assertFalse(should_close(can_go_back=None))

    def test_a_tab_no_link_opened_stays(self):
        self.assertFalse(should_close(opener=None))

    def test_an_opener_in_another_window_keeps_the_tab(self):
        self.assertFalse(should_close(opener={**OPENER, "windowId": 7}))

    def test_an_opener_parked_in_another_space_keeps_the_tab(self):
        # activating it would show a tab of a space the window does not show (G1)
        self.assertFalse(should_close(opener={**OPENER, "vivExtData": ext(12)}))

    def test_a_tab_outside_the_space_on_screen_stays(self):
        self.assertFalse(should_close(tab={**TAB, "vivExtData": ext(12)}, opener={**OPENER, "vivExtData": ext(12)}))

    def test_the_default_space(self):
        self.assertTrue(should_close(tab={**TAB, "vivExtData": ext(0)}, opener={**OPENER, "vivExtData": ext(0)}, shown=0))

    def test_only_the_tab_on_screen(self):
        self.assertFalse(should_close(tab={**TAB, "active": False}))

    def test_pinned_kept_and_self_opened_tabs_stay(self):
        self.assertFalse(should_close(tab={**TAB, "pinned": True}))
        self.assertFalse(should_close(kept=True))
        self.assertFalse(should_close(opener={**OPENER, "id": 2}))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Back behaviour's JavaScript")
class Keys(unittest.TestCase):
    def keys(self, shortcuts, windows):
        return run_js("17-back-closes.js", "window.__vm.back.backKeys(shortcuts, windows)", shortcuts=shortcuts, windows=windows)

    def test_vivaldis_back_chords_normalised(self):
        self.assertEqual(self.keys(["alt+left", "backspace", "z"], True), ["alt+left"])
        self.assertEqual(self.keys(["backspace", "meta+left", "z"], False), ["left+meta"])

    def test_vivaldis_defaults_when_the_table_cannot_be_read(self):
        self.assertEqual(self.keys(None, True), ["alt+left"])
        self.assertEqual(self.keys(None, False), ["left+meta"])

    def test_cmd_left_moves_the_caret_on_a_mac_alt_left_does_not_on_windows(self):
        self.assertTrue(run_js("17-back-closes.js", "window.__vm.back.caretKey('left+meta', false)"))
        self.assertFalse(run_js("17-back-closes.js", "window.__vm.back.caretKey('alt+left', true)"))
        self.assertFalse(run_js("17-back-closes.js", "window.__vm.back.caretKey('[+meta', false)"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Back behaviour's JavaScript")
class ButtonClick(unittest.TestCase):
    def click(self, **c):
        return run_js("17-back-closes.js", "window.__vm.back.backClick(c)", c=c)

    def test_a_real_click_on_the_greyed_out_back_slot_counts(self):
        self.assertTrue(self.click(on=True, trusted=True, onSlot=True, disabled=True))

    def test_a_click_on_something_over_the_button_does_not(self):
        # a menu, the command bar's backdrop or the Ctrl+Tab row that sits over Back's coordinates
        self.assertFalse(self.click(on=True, trusted=True, onSlot=False, disabled=True))

    def test_a_script_made_click_does_not(self):
        self.assertFalse(self.click(on=True, trusted=False, onSlot=True, disabled=True))

    def test_a_back_with_history_or_the_option_off_does_not(self):
        self.assertFalse(self.click(on=True, trusted=True, onSlot=True, disabled=False))
        self.assertFalse(self.click(on=False, trusted=True, onSlot=True, disabled=True))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Back behaviour's JavaScript")
class Openers(unittest.TestCase):
    def test_an_opener_that_is_peeks_preview_is_not_gone_back_to(self):
        self.assertFalse(run_js("17-back-closes.js", "window.__vm.back.shouldClose({ on: true, tab, opener, canGoBack: false, shown: 11, kept: false, openerKept: true })",
                                tab=TAB, opener=OPENER))
        self.assertTrue(run_js("17-back-closes.js", "window.__vm.back.shouldClose({ on: true, tab, opener, canGoBack: false, shown: 11, kept: false })",
                               tab=TAB, opener=OPENER))


class BackSlotStyle(unittest.TestCase):
    """While the option is on, the greyed-out Back button lets clicks through to its slot, and the slot takes them: hit-testable
    and out of any window-drag region (the Dia top row with Vivaldi's frame off, the Arc sidebar's header)."""

    def rule(self, selector_part):
        css = open(os.path.join(os.path.dirname(__file__), "..", "src", "css", "vivarc.css"), encoding="utf-8").read()
        m = re.search(r"([^{}]*" + re.escape(selector_part) + r"[^{}]*)\{([^}]*)\}", css)
        return (m.group(1), m.group(2)) if m else (None, "")

    def test_the_button_lets_the_click_through(self):
        sel, body = self.rule('[data-name="Back"]:disabled')
        self.assertIn("vm-back-closes", sel)
        self.assertIn("pointer-events: none", body)

    def test_the_slot_takes_it_out_of_the_drag_region(self):
        sel, body = self.rule('.button-toolbar:has(> [data-name="Back"]')
        self.assertIn("vm-back-closes", sel or "")
        for prop in ("pointer-events: auto", "-webkit-app-region: no-drag", "app-region: no-drag"):
            self.assertIn(prop, body)


if __name__ == "__main__":
    unittest.main()
