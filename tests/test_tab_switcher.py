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
  "vivaldi.toolbars.tabbar_after": ["AccountButton"], "vivaldi.tabs.bar.position": "left", ...(sc.prefs || {}) };
const ev = { addListener() {} };
global.setTimeout = () => 0;
global.console = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
const bg = { ...(sc.bg || {}) }, order = [];
global.chrome = { extension: { inIncognitoContext: sc.incognito, getBackgroundPage: () => new Proxy(bg, { set: (o, k, v) => { order.push("bg:" + String(k)); o[k] = v; return true; } }) },
  windows: { getCurrent: async () => ({ id: 1, type: "normal" }), getAll: async () => [{ id: sc.leader ? 1 : 0, type: "normal" }, { id: 1, type: "normal" }] },
  tabs: { query: async () => [], update: async () => ({}), onCreated: ev, onUpdated: ev } };
global.vivaldi = { prefs: { get: async (path) => ({ value: JSON.parse(JSON.stringify(prefs[path] ?? null)) }), set: async ({ path, value }) => { sets.push(path); order.push("set:" + path); prefs[path] = value; } } };
const stored = new Map(Object.entries(sc.stored || {}));
global.window = { __vm: { config: { startUrl: "file:///guide.html" }, windows: true, shortcut: (c) => c,
  ...(sc.dia == null ? {} : { settings: { loaded: Promise.resolve(), get: (k) => (k === "diaLayout" ? sc.dia : undefined) } }),
  workspaces: { leaderOf: (wins) => Math.min(...wins.map((w) => w.id)) },
  store: { get: async (k, f) => stored.get(k) ?? f, set: async (k, v) => { stored.set(k, v); } } } };
vm.runInThisContext(fs.readFileSync(require("path").join(process.argv[1], "05-bootstrap.js"), "utf8"));
(async () => {
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
  const ready = await Promise.race([window.__vm.bootstrap.keysReady.then(() => true), new Promise((r) => setImmediate(() => r(false)))]);
  process.stdout.write(JSON.stringify({ sets, stored: Object.fromEntries(stored), table: prefs["vivaldi.actions"][0], logs, bg, order, ready,
    freedThisRun: await window.__vm.bootstrap.freedThisRun() }) + "\n");
})();
'''
VIVALDI = {"COMMAND_TAB_SWITCH_FORWARD_SETTING": {"shortcuts": ["ctrl+tab"]}, "COMMAND_TAB_SWITCH_BACK_SETTING": {"shortcuts": ["ctrl+shift+tab"]},
           "COMMAND_SAVE_PAGE": {"shortcuts": ["meta+s"]}, "COMMAND_PAGE_BACK": {"shortcuts": ["alt+left"]}}


def setup_run(table=VIVALDI, incognito=False, leader=True, stored=None, prefs=None, bg=None, dia=None):
    out = subprocess.run(["node", "-e", SETUP, JS, json.dumps({"table": table, "incognito": incognito, "leader": leader, "stored": stored or {},
                                                                 "prefs": prefs or {}, "bg": bg or {}, "dia": dia})],
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
        # the run is marked on the shared background page BEFORE the table is written, and nothing is kept with a clock
        self.assertTrue(out["bg"]["__vivarcTabKeysFreedRun"])
        self.assertTrue(out["freedThisRun"])
        mark = out["order"].index("bg:__vivarcTabKeysFreedRun")
        self.assertEqual(out["order"][:mark].count("set:vivaldi.actions"), 1)  # only Ctrl+S's write came before the mark
        self.assertEqual(out["order"][mark + 1], "set:vivaldi.actions")  # the tab keys' write comes right after it
        self.assertNotIn("tabKeysFreedAt", out["stored"])
        self.assertTrue(out["ready"])
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
        self.assertFalse(out["freedThisRun"])  # nothing freed this run: the switcher may take the keys now
        self.assertTrue(out["ready"])

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
        self.assertTrue(out["ready"])  # its switcher does not wait for a setup that never runs



# Final fix round (AGY's setup-flag design): Vivarc's store is written at once, Vivaldi's Preferences on a delay, so a hard
# kill seconds after the first launch kept "done" and lost the keys and toolbars. Each flag is now written "pending" (with
# the run it was written in) right after the pref writes, and a later launch makes it done only when the profile shows the
# change, else applies it again. Done stays done: a key the user puts back later is never taken again.
FREED = {"COMMAND_TAB_SWITCH_FORWARD_SETTING": {"shortcuts": []}, "COMMAND_TAB_SWITCH_BACK_SETTING": {"shortcuts": []},
         "COMMAND_SAVE_PAGE": {"shortcuts": []}, "COMMAND_PAGE_BACK": {"shortcuts": ["alt+left"]}}
SHOWN = {"vivaldi.address_bar.extensions.render_in_dropdown": True, "vivaldi.address_bar.visible": False,
         "vivaldi.toolbars.tabbar_before": ["TabButton", "AddressField"]}
OLD_RUN = {"tabKeysFreed": {"pending": True, "run": "old"}, "sidebarKeyFreed": {"pending": True, "run": "old"},
           "extensionsDropdown": {"pending": True, "run": "old"}, "bootstrap": {"pending": 16, "done": 0, "run": "old"}}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the profile setup's JavaScript")
class SetupFlags(unittest.TestCase):
    def test_the_first_launch_writes_each_flag_pending_not_done(self):
        out = setup_run()
        run = out["bg"]["__vivarcSetupRun"]
        self.assertTrue(run)
        for key in ("tabKeysFreed", "sidebarKeyFreed", "extensionsDropdown"):
            self.assertEqual(out["stored"][key], {"pending": True, "run": run, "tries": 0}, key)
        self.assertEqual(out["stored"]["bootstrap"], {"pending": 16, "done": 0, "run": run, "tries": 0})

    def test_a_hard_kill_before_preferences_were_written_applies_it_all_again(self):
        # the store says pending (an earlier run); Vivaldi's prefs are stock: Ctrl+Tab and Ctrl+S back on Vivaldi's commands
        out = setup_run(stored=dict(OLD_RUN))
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_FORWARD_SETTING"]["shortcuts"], [], "Ctrl+Tab freed again")
        self.assertEqual(out["table"]["COMMAND_SAVE_PAGE"]["shortcuts"], [], "Ctrl+S freed again")
        self.assertIn("vivaldi.address_bar.visible", out["sets"], "the toolbars and the address row applied again")
        self.assertIn("vivaldi.tabs.bar.width", out["sets"], "a profile never set up gets the first-run settings again")
        self.assertIn("vivaldi.address_bar.extensions.render_in_dropdown", out["sets"])
        self.assertTrue(out["freedThisRun"], "the switcher waits for the next start, as on a first launch")
        run = out["bg"]["__vivarcSetupRun"]
        self.assertNotEqual(run, "old")
        self.assertEqual(out["stored"]["tabKeysFreed"], {"pending": True, "run": run, "tries": 1}, "pending again, this run (a second try)")
        self.assertEqual(out["stored"]["bootstrap"], {"pending": 16, "done": 0, "run": run, "tries": 1})

    def test_a_later_launch_that_sees_the_change_makes_it_done_and_writes_nothing(self):
        out = setup_run(table=FREED, stored=dict(OLD_RUN), prefs=SHOWN)
        self.assertEqual({k: out["stored"][k] for k in ("tabKeysFreed", "sidebarKeyFreed", "extensionsDropdown", "bootstrap")},
                         {"tabKeysFreed": True, "sidebarKeyFreed": True, "extensionsDropdown": True, "bootstrap": 16})
        for path in ("vivaldi.actions", "vivaldi.address_bar.visible", "vivaldi.address_bar.extensions.render_in_dropdown", "vivaldi.tabs.bar.width"):
            self.assertNotIn(path, out["sets"], path)
        self.assertFalse(out["freedThisRun"])

    def test_once_done_a_key_the_user_puts_back_stays(self):
        # done (true / a version): Ctrl+Tab back on Vivaldi's command, the address row back on: left as the user set them
        out = setup_run(stored={"tabKeysFreed": True, "sidebarKeyFreed": True, "bootstrap": 16, "extensionsDropdown": True},
                        prefs={"vivaldi.address_bar.visible": True})
        self.assertEqual(out["table"]["COMMAND_TAB_SWITCH_FORWARD_SETTING"]["shortcuts"], ["ctrl+tab"])
        self.assertEqual(out["table"]["COMMAND_SAVE_PAGE"]["shortcuts"], ["meta+s"])
        for path in ("vivaldi.actions", "vivaldi.address_bar.visible", "vivaldi.address_bar.extensions.render_in_dropdown", "vivaldi.toolbars.tabbar_before"):
            self.assertNotIn(path, out["sets"], path)
        self.assertEqual(out["stored"]["tabKeysFreed"], True)

    def test_pending_from_this_same_run_is_neither_promoted_nor_applied_again(self):
        # another window of the run that wrote it: Vivaldi's prefs in memory always show the change, so nothing is proven yet
        same = {k: ({**v, "run": "now"}) for k, v in OLD_RUN.items()}
        out = setup_run(table=FREED, stored=same, prefs=SHOWN, bg={"__vivarcSetupRun": "now"})
        self.assertEqual(out["stored"], same)
        self.assertNotIn("vivaldi.actions", out["sets"])
        self.assertNotIn("vivaldi.address_bar.visible", out["sets"])

    def test_a_version_bump_cut_short_applies_the_steps_again_but_not_the_first_run_settings(self):
        out = setup_run(stored={"tabKeysFreed": True, "sidebarKeyFreed": True, "extensionsDropdown": True,
                                "bootstrap": {"pending": 16, "done": 15, "run": "old"}})
        self.assertIn("vivaldi.address_bar.visible", out["sets"])
        self.assertNotIn("vivaldi.tabs.bar.width", out["sets"], "a profile set up before keeps its own width and auto-hide")
        self.assertEqual(out["stored"]["bootstrap"]["done"], 15)

    def test_a_bump_from_a_done_version_keeps_that_version_as_done_while_pending(self):
        out = setup_run(stored={"tabKeysFreed": True, "sidebarKeyFreed": True, "extensionsDropdown": True, "bootstrap": 15})
        self.assertEqual(out["stored"]["bootstrap"], {"pending": 16, "done": 15, "run": out["bg"]["__vivarcSetupRun"], "tries": 0})
        self.assertNotIn("vivaldi.tabs.bar.width", out["sets"])

    def test_the_dia_layout_turning_the_address_row_on_still_counts_as_set_up(self):
        # Dia turns vivaldi.address_bar.visible on at every start (15-dia.js): the setup survived when its toolbars did
        out = setup_run(table=FREED, stored=dict(OLD_RUN), prefs={**SHOWN, "vivaldi.address_bar.visible": True}, dia=True)
        self.assertEqual(out["stored"]["bootstrap"], 16, "promoted, not applied again at every launch")
        self.assertNotIn("vivaldi.tabs.bar.width", out["sets"])
        self.assertNotIn("vivaldi.address_bar.visible", out["sets"])

    def test_without_dia_an_address_row_still_on_is_applied_again(self):
        out = setup_run(table=FREED, stored=dict(OLD_RUN), prefs={**SHOWN, "vivaldi.address_bar.visible": True}, dia=False)
        self.assertIn("vivaldi.address_bar.visible", out["sets"])
        self.assertEqual(out["stored"]["bootstrap"]["tries"], 1)

    def test_a_check_that_never_passes_gives_up_after_three_tries(self):
        # whatever keeps the profile from showing the change, the setup is not applied at every launch for ever
        worn = {k: {**v, "tries": 3} for k, v in OLD_RUN.items()}
        out = setup_run(stored=worn)
        self.assertEqual(out["stored"]["tabKeysFreed"], True)
        self.assertEqual(out["stored"]["bootstrap"], 16)
        self.assertNotIn("vivaldi.actions", out["sets"])
        self.assertNotIn("vivaldi.address_bar.visible", out["sets"])
        self.assertTrue(any("gave up" in str(m) for m in out["logs"]), out["logs"])

    def test_a_private_window_promotes_nothing(self):
        out = setup_run(table=FREED, stored=dict(OLD_RUN), prefs=SHOWN, incognito=True)
        self.assertEqual(out["sets"], [])
        self.assertEqual(out["stored"], OLD_RUN)

@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class Decision(unittest.TestCase):
    """When the switcher takes Ctrl+Tab. Anything not known leaves it to Vivaldi, whose cycling then works."""

    def decide(self, **state):
        return js("window.__vm.switcher.decision(state)", state=state)

    def test_a_fresh_run_vivaldi_still_holds_the_keys(self):
        out = self.decide(readable=True, holders=["COMMAND_TAB_SWITCH_FORWARD_SETTING"], freedThisRun=False)
        self.assertFalse(out["armed"])
        self.assertIn("COMMAND_TAB_SWITCH_FORWARD_SETTING", out["reason"])

    def test_freed_during_this_run_vivaldi_keeps_them_until_the_next_start(self):
        self.assertFalse(self.decide(readable=True, holders=[], freedThisRun=True)["armed"])

    def test_freed_in_a_previous_run_the_switcher_takes_them(self):
        self.assertEqual(self.decide(readable=True, holders=[], freedThisRun=False), {"armed": True, "reason": "armed"})

    def test_a_read_error_leaves_ctrl_tab_to_vivaldi(self):
        self.assertFalse(self.decide(readable=False)["armed"])
        self.assertFalse(self.decide(readable=True, holders=[], freedThisRun=None)["armed"])

    def test_no_clock_is_read_so_a_clock_step_cannot_strand_it(self):
        # an old build's freeing time, in the future after a clock step back, changes nothing: the decision has no clock
        self.assertTrue(self.decide(readable=True, holders=[], freedThisRun=False, tabKeysFreedAt=10 ** 15)["armed"])

    def test_the_fallback_card_names_the_site(self):
        self.assertEqual(js("[window.__vm.switcher.hostOf('https://www.github.com/x'), window.__vm.switcher.monogram({ url: 'https://news.ycombinator.com/' }), window.__vm.switcher.monogram({ url: 'about:blank', title: 'start' })]"),
                         ["github.com", "N", "S"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class RowKeys(unittest.TestCase):
    """While the row is up: what each key does. Nothing that is not the switcher's is swallowed into a switch."""

    def key(self, key, ctrl):
        return js("window.__vm.switcher.rowKey(key, ctrl)", key=key, ctrl=ctrl)

    def test_escape_cancels_ctrl_held_or_not(self):
        self.assertEqual([self.key("Escape", True), self.key("Escape", False)], ["cancel", "cancel"])

    def test_tab_and_the_arrows_step_and_enter_switches_with_ctrl(self):
        self.assertEqual([self.key(k, True) for k in ("Tab", "ArrowLeft", "ArrowRight", "Enter")], ["step", "step", "step", "commit"])

    def test_a_key_without_ctrl_or_another_ctrl_chord_ends_the_row_without_switching(self):
        self.assertEqual([self.key("a", False), self.key(" ", False), self.key("Enter", False), self.key("c", True), self.key("f", True)],
                         ["leave", "leave", "leave", "leave", "leave"])

    def test_the_modifiers_alone_change_nothing(self):
        self.assertEqual([self.key(k, True) for k in ("Control", "Shift", "Alt", "Meta")], ["ignore"] * 4)

    def test_a_late_answer_is_a_tenth_of_a_second(self):
        self.assertEqual(js("window.__vm.switcher.LATE_MS"), 100)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class TableChanges(unittest.TestCase):
    def change(self, before, after):
        return js("window.__vm.switcher.tableChange({ before, after })", before=before, after=after)

    def test_a_key_back_on_a_vivaldi_command_lets_go(self):
        self.assertEqual(self.change([], ["COMMAND_TAB_SWITCH_FORWARD_SETTING"]), {"disarm": True, "freedNow": False})

    def test_bound_then_free_is_freed_this_run(self):
        self.assertEqual(self.change(["COMMAND_TAB_SWITCH_FORWARD_SETTING"], []), {"disarm": False, "freedNow": True})

    def test_free_and_free_or_unknown_before_is_nothing(self):
        self.assertEqual(self.change([], []), {"disarm": False, "freedNow": False})
        self.assertEqual(self.change(None, []), {"disarm": False, "freedNow": False})


# 00-core.js's key hook: a key heard twice within 250 ms counts once, except the switcher's, where two quick taps are meant.
CORE = r'''
const fs = require("fs"), vm = require("vm"), path = require("path");
let hook = null;
global.console = { log() {}, warn() {} };
global.indexedDB = { open: () => ({}) };
global.document = { querySelector: () => null, documentElement: {}, readyState: "complete" };
global.MutationObserver = class { observe() {} disconnect() {} };
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.setTimeout = () => 0;
global.vivaldi = { tabsPrivate: { onKeyboardShortcut: { addListener: (fn) => { hook = fn; } } } };
global.window = { __vmConfig: { platform: "Windows" } };
vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], "00-core.js"), "utf8"));
const heard = [];
window.__vm.onShortcut((key) => heard.push(key));
for (const combo of JSON.parse(process.argv[2])) hook(1, combo);
process.stdout.write(JSON.stringify(heard));
'''


def core(combos):
    out = subprocess.run(["node", "-e", CORE, JS, json.dumps(combos)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the core's JavaScript")
class QuickTaps(unittest.TestCase):
    def test_a_second_quick_ctrl_tab_is_heard(self):
        self.assertEqual(core(["Ctrl+Tab", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+Tab"]), ["ctrl+tab", "ctrl+tab", "ctrl+shift+tab", "ctrl+shift+tab"])

    def test_other_keys_heard_twice_still_count_once(self):
        self.assertEqual(core(["Ctrl+S", "Ctrl+S"]), ["ctrl+s"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class VivaldisKeyEvents(unittest.TestCase):
    """Vivaldi's onKeyboardChanged(windowId, down, modifiers, keyCode): measured on 8.3, a quick Ctrl+Tab's Ctrl release
    reaches the UI only this way while the page has the cursor."""

    def change(self, **e):
        return js("window.__vm.switcher.keyboardChange(e)", e=e)

    def test_ctrl_down_and_up_in_this_window(self):
        self.assertEqual(self.change(own=5, windowId=5, down=True, keyCode=17), "ctrl-down")
        self.assertEqual(self.change(own=5, windowId=5, down=False, keyCode=17), "ctrl-up")

    def test_escape_going_down(self):
        self.assertEqual(self.change(own=5, windowId=5, down=True, keyCode=27), "escape")
        self.assertIsNone(self.change(own=5, windowId=5, down=False, keyCode=27))

    def test_another_windows_keys_and_other_keys_are_nothing(self):
        self.assertIsNone(self.change(own=5, windowId=6, down=False, keyCode=17))
        self.assertIsNone(self.change(own=5, windowId=5, down=False, keyCode=9))

    def test_without_both_window_ids_it_is_taken_as_this_windows(self):
        self.assertEqual(self.change(windowId=5, down=False, keyCode=17), "ctrl-up")


if __name__ == "__main__":
    unittest.main()
