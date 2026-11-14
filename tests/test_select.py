"""Picking several tab rows (09-select.js): Ctrl/Cmd+click picks, Shift+click a range, the tab on screen counts first."""
import json
import shutil
import unittest

from jsrun import run_js


def js(expr, **data):
    return run_js("09-select.js", expr, **data)


ORDER = [9, 7, 5, 3, 1]  # rows as listed, top to bottom (the highest tab index first)


def pick(id, selected=(), anchor=None, active=None, order=ORDER, extend=False):
    return js("window.__vm.select.pick({ selected, anchor, active, order }, id, { extend })", id=id, selected=list(selected), anchor=anchor,
              active=active, order=list(order), extend=extend)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Picking(unittest.TestCase):
    def test_the_first_pick_takes_the_tab_on_screen_too(self):
        self.assertEqual(pick(5, active=9), {"selected": [9, 5], "anchor": 5})

    def test_a_first_pick_of_the_tab_on_screen_is_just_that_tab(self):
        self.assertEqual(pick(9, active=9), {"selected": [9], "anchor": 9})

    def test_the_tab_on_screen_counts_only_when_its_row_is_listed(self):
        self.assertEqual(pick(5, active=42), {"selected": [5], "anchor": 5})

    def test_a_second_pick_adds_and_a_pick_on_a_picked_row_lets_it_go(self):
        self.assertEqual(pick(1, selected=[9, 5], anchor=5, active=9), {"selected": [9, 5, 1], "anchor": 1})
        self.assertEqual(pick(5, selected=[9, 5, 1], anchor=1, active=9), {"selected": [9, 1], "anchor": 5})

    def test_shift_picks_the_range_from_the_last_pick(self):
        self.assertEqual(pick(1, selected=[7], anchor=7, active=9, extend=True), {"selected": [7, 5, 3, 1], "anchor": 7})

    def test_shift_works_upwards_too(self):
        self.assertEqual(pick(9, selected=[3], anchor=3, extend=True), {"selected": [9, 7, 5, 3], "anchor": 3})

    def test_shift_with_nothing_picked_runs_from_the_tab_on_screen(self):
        self.assertEqual(pick(3, active=7, extend=True), {"selected": [7, 5, 3], "anchor": 7})

    def test_shift_with_nothing_to_run_from_picks_the_row(self):
        self.assertEqual(pick(3, extend=True), {"selected": [3], "anchor": 3})

    def test_a_range_adds_to_what_is_picked(self):
        self.assertEqual(pick(3, selected=[9, 5], anchor=5, extend=True), {"selected": [9, 5, 3], "anchor": 5})

    def test_rows_no_longer_listed_are_dropped(self):
        self.assertEqual(pick(1, selected=[42, 9], anchor=9), {"selected": [9, 1], "anchor": 1})
        self.assertEqual(js("window.__vm.select.prune([1, 2, 3], [3, 1, 8])"), [1, 3])

    def test_an_anchor_no_longer_listed_falls_back_to_the_tab_on_screen(self):
        self.assertEqual(pick(1, selected=[], anchor=42, active=5, extend=True), {"selected": [5, 3, 1], "anchor": 5})

    def test_range(self):
        self.assertEqual(js("window.__vm.select.range(order, 7, 3)", order=ORDER), [7, 5, 3])
        self.assertEqual(js("window.__vm.select.range(order, 3, 7)", order=ORDER), [7, 5, 3])
        self.assertEqual(js("window.__vm.select.range(order, 42, 3)", order=ORDER), [3])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Clicks(unittest.TestCase):
    def picking(self, event, windows):
        return js("window.__vm.select.picking(event, windows)", event=event, windows=windows)

    def test_ctrl_on_windows_cmd_on_a_mac(self):
        self.assertTrue(self.picking({"ctrlKey": True}, True))
        self.assertFalse(self.picking({"metaKey": True}, True))
        self.assertTrue(self.picking({"metaKey": True}, False))
        self.assertFalse(self.picking({"ctrlKey": True}, False))  # Ctrl+click on a Mac is the right-click

    def test_shift_on_both_and_a_plain_click_never(self):
        self.assertTrue(self.picking({"shiftKey": True}, True))
        self.assertTrue(self.picking({"shiftKey": True}, False))
        self.assertFalse(self.picking({}, True))
        self.assertFalse(self.picking({"altKey": True}, True))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Menu(unittest.TestCase):
    def test_labels_count_the_tabs(self):
        out = js("(() => { const l = window.__vm.select.labels(3); return [l.stack, l.close, l.move('Work')]; })()")
        self.assertEqual(out, ["Stack 3 Tabs", "Close 3 Tabs", "Move 3 Tabs to Work"])

    def test_picked_tabs_by_the_folder_on_screen_they_are_in(self):
        tabs = [{"id": 1, "g": "a"}, {"id": 2, "g": ""}, {"id": 3, "g": "b"}, {"id": 4, "g": "a"}, {"id": 5, "g": "hidden"}]
        out = js("window.__vm.select.byFolder(tabs, (t) => t.g, ['a', 'b'])", tabs=tabs)
        self.assertEqual([(g["id"], [t["id"] for t in g["tabs"]]) for g in out], [("a", [1, 4]), ("b", [3])])


if __name__ == "__main__":
    unittest.main()
