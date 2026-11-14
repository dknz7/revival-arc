"""The Ctrl+Tab switcher (25-tab-switcher.js): this window's tabs in the space it shows, most recently used first, and the
profile setup that frees Ctrl+Tab from Vivaldi's tab cycling (05-bootstrap.js)."""
import json
import os
import shutil
import subprocess
import unittest

from jsrun import run_js

JS = os.path.join(os.path.dirname(__file__), "..", "src", "js")


def js(expr, **data):
    return run_js("25-tab-switcher.js", expr, **data)


def tab(id, window=1, space=0, accessed=0, active=False, url=None):
    ext = {"workspaceId": space} if space else {}
    return {"id": id, "windowId": window, "active": active, "lastAccessed": accessed, "url": url or f"https://{id}.test/",
            "vivExtData": json.dumps(ext)}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class Order(unittest.TestCase):
    def order(self, tabs, window=1, space=0, skip=None):
        expr = "window.__vm.switcher.order(tabs, { windowId, space, skip: skip ? (t) => skip.includes(t.id) : undefined }).map((t) => t.id)"
        return js(expr, tabs=tabs, windowId=window, space=space, skip=skip)

    def test_the_tab_on_screen_first_then_most_recently_used(self):
        tabs = [tab(1, accessed=100), tab(2, accessed=300, active=True), tab(3, accessed=900), tab(4, accessed=200)]
        self.assertEqual(self.order(tabs), [2, 3, 4, 1])

    def test_only_this_windows_tabs(self):
        tabs = [tab(1, window=1, accessed=1, active=True), tab(2, window=2, accessed=9), tab(3, window=1, accessed=5)]
        self.assertEqual(self.order(tabs, window=1), [1, 3])

    def test_only_the_space_this_window_shows(self):
        # X = 11 is shown here; Y = 12 is parked in the same window and must never be offered (G1 would follow)
        tabs = [tab(1, space=11, accessed=1, active=True), tab(2, space=12, accessed=9), tab(3, space=11, accessed=5), tab(4, accessed=7)]
        self.assertEqual(self.order(tabs, space=11), [1, 3])

    def test_the_default_space_is_space_zero(self):
        tabs = [tab(1, accessed=1, active=True), tab(2, space=12, accessed=9), tab(3, accessed=5)]
        self.assertEqual(self.order(tabs, space=0), [1, 3])
        self.assertEqual(self.order(tabs, space=None), [1, 3])

    def test_at_most_five(self):
        tabs = [tab(i, accessed=i) for i in range(1, 9)]
        self.assertEqual(self.order(tabs), [8, 7, 6, 5, 4])

    def test_skipped_tabs_are_left_out_but_never_the_one_on_screen(self):
        tabs = [tab(1, accessed=1, active=True), tab(2, accessed=9), tab(3, accessed=5)]
        self.assertEqual(self.order(tabs, skip=[1, 2]), [1, 3])

    def test_a_tab_never_used_sorts_last(self):
        tabs = [tab(1, active=True), {**tab(2), "lastAccessed": None}, tab(3, accessed=5)]
        self.assertEqual(self.order(tabs), [1, 3, 2])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class Stepping(unittest.TestCase):
    def test_the_first_press_goes_to_the_previous_tab_and_shift_to_the_least_recent(self):
        self.assertEqual(js("[window.__vm.switcher.first(1, 4), window.__vm.switcher.first(-1, 4)]"), [1, 3])

    def test_no_other_tab_no_row(self):
        self.assertIsNone(js("window.__vm.switcher.first(1, 1)"))
        self.assertIsNone(js("window.__vm.switcher.first(1, 0)"))

    def test_steps_wrap_both_ways(self):
        self.assertEqual(js("[window.__vm.switcher.step(3, 1, 4), window.__vm.switcher.step(0, -1, 4), window.__vm.switcher.step(1, 1, 4)]"), [0, 3, 2])

    def test_the_keys_are_ctrl_on_every_platform(self):
        self.assertEqual(js("[window.__vm.switcher.NEXT_KEY, window.__vm.switcher.PREV_KEY]"), ["ctrl+tab", "ctrl+shift+tab"])


# 05-bootstrap.js against fake prefs: a profile whose Vivaldi holds Ctrl+Tab (its 8.3 defaults), in a normal or private window.
SETUP = r'''
const fs = require("fs"), vm = require("vm");
const sc = JSON.parse(process.argv[2]);
const sets = [], logs = [], prefs = { "vivaldi.actions": [sc.table], "vivaldi.toolbars.tabbar_before": ["AddressField"],
  "vivaldi.toolbars.tabbar_after": ["AccountButton"], "vivaldi.tabs.bar.position": "left" };
const ev = { addListener() {} };
global.setTimeout = () => 0;
global.console = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
global.chrome = { extension: { inIncognitoContext: sc.incognito },
  windows: { getCurrent: async () => ({ id: 1, type: "normal" }), getAll: async () => [{ id: sc.leader ? 1 : 0, type: "normal" }, { id: 1, type: "normal" }] },
  tabs: { query: async () => [], update: async () => ({}), onCreated: ev, onUpdated: ev } };
global.vivaldi = { prefs: { get: async (path) => ({ value: JSON.parse(JSON.stringify(prefs[path] ?? null)) }), set: async ({ path, value }) => { sets.push(path); prefs[path] = value; } } };
const stored = new Map(Object.entries(sc.stored || {}));
global.window = { __vm: { config: { startUrl: "file:///guide.html" }, windows: true, shortcut: (c) => c,
  workspaces: { leaderOf: (wins) => Math.min(...wins.map((w) => w.id)) },
  store: { get: async (k, f) => stored.get(k) ?? f, set: async (k, v) => { stored.set(k, v); } } } };
vm.runInThisContext(fs.readFileSync(require("path").join(process.argv[1], "05-bootstrap.js"), "utf8"));
(async () => {
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
  process.stdout.write(JSON.stringify({ sets, stored: Object.fromEntries(stored), table: prefs["vivaldi.actions"][0], logs }) + "\n");
})();
'''
VIVALDI = {"COMMAND_TAB_SWITCH_FORWARD_SETTING": {"shortcuts": ["ctrl+tab"]}, "COMMAND_TAB_SWITCH_BACK_SETTING": {"shortcuts": ["ctrl+shift+tab"]},
           "COMMAND_SAVE_PAGE": {"shortcuts": ["meta+s"]}, "COMMAND_PAGE_BACK": {"shortcuts": ["alt+left"]}}


def setup_run(table=VIVALDI, incognito=False, leader=True, stored=None):
    out = subprocess.run(["node", "-e", SETUP, JS, json.dumps({"table": table, "incognito": incognito, "leader": leader, "stored": stored or {}})],
                         check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the profile setup's JavaScript")
class FreeingCtrlTab(unittest.TestCase):
    def test_the_leader_frees_both_keys_from_vivaldis_tab_cycling_and_says_which_command_held_them(self):
        out = setup_run()
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_FORWARD_SETTING"]["shortcuts"], [])
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_BACK_SETTING"]["shortcuts"], [])
        self.assertEqual(out["table"]["COMMAND_PAGE_BACK"]["shortcuts"], ["alt+left"])
        self.assertTrue(out["stored"]["tabKeysFreed"])
        self.assertIsInstance(out["stored"]["tabKeysFreedAt"], (int, float))
        self.assertIn("[vivarc] Ctrl+Tab freed from COMMAND_TAB_SWITCH_FORWARD_SETTING", out["logs"])
        self.assertIn("[vivarc] Ctrl+Shift+Tab freed from COMMAND_TAB_SWITCH_BACK_SETTING", out["logs"])

    def test_ctrl_s_is_still_freed_as_before(self):
        # the fake's shortcut() leaves keys as written, so the sidebar key is meta+s here (Ctrl+S once mapped on Windows)
        out = setup_run()
        self.assertEqual(out["table"]["COMMAND_SAVE_PAGE"]["shortcuts"], [])
        self.assertTrue(out["stored"]["sidebarKeyFreed"])
        self.assertIn("[vivarc] Ctrl+S freed from COMMAND_SAVE_PAGE", out["logs"])

    def test_a_key_already_free_marks_it_done_with_no_freeing_time(self):
        # no freeing time: Vivaldi already did not have the key at launch, so the switcher can start now
        out = setup_run(table={"COMMAND_PAGE_BACK": {"shortcuts": ["alt+left"]}})
        self.assertTrue(out["stored"]["tabKeysFreed"])
        self.assertNotIn("tabKeysFreedAt", out["stored"])

    def test_once_per_profile_a_key_put_back_later_stays(self):
        out = setup_run(stored={"tabKeysFreed": True, "sidebarKeyFreed": True, "bootstrap": 99, "extensionsDropdown": True})
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_FORWARD_SETTING"]["shortcuts"], ["ctrl+tab"])
        self.assertNotIn("vivaldi.actions", out["sets"])

    def test_a_window_that_is_not_the_leader_leaves_it_to_the_leader(self):
        out = setup_run(leader=False, stored={"bootstrap": 99, "extensionsDropdown": True})
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_FORWARD_SETTING"]["shortcuts"], ["ctrl+tab"])
        self.assertNotIn("tabKeysFreed", out["stored"])

    def test_a_private_window_frees_nothing(self):
        out = setup_run(incognito=True)
        self.assertEqual(out["sets"], [])
        self.assertEqual(out["stored"], {})


if __name__ == "__main__":
    unittest.main()
