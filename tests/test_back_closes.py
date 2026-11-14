"""Back closes a tab a link opened (17-back-closes.js): when, and only when, Back on it would do nothing today."""
import json
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


if __name__ == "__main__":
    unittest.main()
