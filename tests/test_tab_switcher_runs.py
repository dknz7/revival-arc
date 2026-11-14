"""Whether the Ctrl+Tab switcher takes the keys, run by run and window by window (05-bootstrap.js with 25-tab-switcher.js
against fake prefs, background pages and windows). Vivaldi reads its key table at launch, so in the run the keys are freed
it still cycles tabs itself: no window may take Ctrl+Tab then, and from the next run every window must, private ones too."""
import json
import os
import shutil
import subprocess
import unittest

JS = os.path.join(os.path.dirname(__file__), "..", "src", "js")

# sc: { table, incognito, bg: "shared" | "own" | null, leader, flagged (the shared page already marked), steps: [...] }
# steps: ["unbind"] (the other side frees the keys and the pref changes), ["rebind"] (a key goes back on Vivaldi's command),
# ["press"] (asks again, as a press does while standing down). Reports the switcher's state after the setup and each step.
HARNESS = r'''
const fs = require("fs"), vm = require("vm"), path = require("path");
const sc = JSON.parse(process.argv[2]);
const prefs = { "vivaldi.actions": [sc.table], "vivaldi.toolbars.tabbar_before": ["AddressField"], "vivaldi.toolbars.tabbar_after": ["AccountButton"], "vivaldi.tabs.bar.position": "left" };
const shared = sc.flagged ? { __vivarcTabKeysFreedRun: true } : {};
const own = {};
const bg = sc.bg === "shared" ? shared : sc.bg === "own" ? own : null;
const changed = [];
const ev = { addListener() {} };
global.console = { log() {}, warn() {} };
const timers = [];
global.setTimeout = (fn, ms) => { if (!ms || ms < 1000) timers.push(fn); return 0; };
global.document = { querySelector: () => null, body: {}, createElement: () => ({}) };
global.chrome = { extension: { inIncognitoContext: !!sc.incognito, getBackgroundPage: () => bg },
  windows: { getCurrent: async () => ({ id: 1, type: "normal" }), getAll: async () => [{ id: sc.leader === false ? 0 : 1, type: "normal" }, { id: 1, type: "normal" }] },
  tabs: { query: async () => [], update: async () => ({}), onCreated: ev, onUpdated: ev, onActivated: ev, onRemoved: ev } };
global.vivaldi = { prefs: { get: async (p) => ({ value: JSON.parse(JSON.stringify(prefs[p] ?? null)) }), set: async ({ path: p, value }) => { prefs[p] = value; },
  onChanged: { addListener: (fn) => changed.push(fn) } }, thumbnails: {} };
const stored = new Map(Object.entries(sc.stored || {}));
global.window = { __vm: { config: { startUrl: "x" }, windows: true, shortcut: (c) => c, cssLoaded: true, normalise: (c) => String(c).toLowerCase().split("+").sort().join("+"),
  onShortcut() {}, workspaces: { leaderOf: (w) => Math.min(...w.map((x) => x.id)) },
  store: { get: async (k, f) => stored.get(k) ?? f, set: async (k, v) => { stored.set(k, v); } } }, addEventListener() {}, removeEventListener() {} };
for (const f of ["05-bootstrap.js", "25-tab-switcher.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
const settle = async () => { for (let i = 0; i < 60; i++) { while (timers.length) timers.shift()(); await new Promise((r) => setImmediate(r)); } };
const state = () => { const s = window.__vm.switcher.state(); return { armed: s.armed, reason: s.reason }; };
(async () => {
  await settle();
  const out = [state()];
  for (const step of sc.steps || []) {
    const t = prefs["vivaldi.actions"][0];
    if (step === "unbind") { for (const c of Object.values(t)) if (Array.isArray(c.shortcuts)) c.shortcuts = c.shortcuts.filter((k) => !/tab$/.test(k)); changed.forEach((fn) => fn({ path: "vivaldi.actions" })); }
    if (step === "rebind") { t.COMMAND_TAB_SWITCH_FORWARD_SETTING = { shortcuts: ["ctrl+tab"] }; changed.forEach((fn) => fn("vivaldi.actions")); }
    if (step === "press") await window.__vm.switcher.recheck();
    await settle();
    out.push(state());
  }
  process.stdout.write(JSON.stringify({ out, shared, own }) + "\n");
})();
'''
HELD = {"COMMAND_TAB_SWITCH_FORWARD_SETTING": {"shortcuts": ["ctrl+tab"]}, "COMMAND_TAB_SWITCH_BACK_SETTING": {"shortcuts": ["ctrl+shift+tab"]}}
FREE = {"COMMAND_TAB_SWITCH_FORWARD_SETTING": {"shortcuts": []}, "COMMAND_TAB_SWITCH_BACK_SETTING": {"shortcuts": []}}
DONE = {"bootstrap": 99, "extensionsDropdown": True, "sidebarKeyFreed": True}


def run(**sc):
    out = subprocess.run(["node", "-e", HARNESS, JS, json.dumps(sc)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class Runs(unittest.TestCase):
    def test_a_later_run_every_normal_window_takes_ctrl_tab(self):
        self.assertTrue(run(table=FREE, bg="shared", stored={**DONE, "tabKeysFreed": True})["out"][0]["armed"])

    def test_the_run_the_leader_frees_the_keys_it_does_not(self):
        out = run(table=HELD, bg="shared", stored=DONE)
        self.assertFalse(out["out"][0]["armed"])
        self.assertTrue(out["shared"]["__vivarcTabKeysFreedRun"])

    def test_another_normal_window_of_that_run_does_not_either(self):
        # the leader has marked the shared background page; this window is not the leader
        out = run(table=FREE, bg="shared", flagged=True, leader=False, stored={**DONE, "tabKeysFreed": True})
        self.assertFalse(out["out"][0]["armed"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class PrivateWindows(unittest.TestCase):
    def test_a_later_run_with_no_background_page_still_takes_ctrl_tab(self):
        # nothing to read the run from is not "freed this run": standing down would leave Ctrl+Tab dead (Vivaldi's is gone)
        self.assertTrue(run(table=FREE, bg=None, incognito=True)["out"][0]["armed"])

    def test_a_later_run_with_a_background_page_of_its_own_takes_it(self):
        self.assertTrue(run(table=FREE, bg="own", incognito=True)["out"][0]["armed"])

    def test_open_while_a_normal_window_frees_the_keys_it_stays_off_for_the_run(self):
        # private window first: the keys go free on the other side, which only the table's change tells it; a press after
        # that must not take Ctrl+Tab from Vivaldi, which still has it until the restart
        for bg in ("own", None):
            out = run(table=HELD, bg=bg, incognito=True, steps=["unbind", "press"])["out"]
            self.assertFalse(out[0]["armed"], bg)
            self.assertFalse(out[1]["armed"], bg)
            self.assertFalse(out[2]["armed"], bg)
            self.assertIn("freed during this run", out[2]["reason"])

    def test_opened_after_the_keys_were_freed_in_that_run_cannot_tell(self):
        # Known limit: a private window opened after the normal side freed the keys, in that same run, sees a free table
        # and no mark (its background page is its own), so it takes Ctrl+Tab while Vivaldi still cycles too, until the
        # next start. Nothing a private window can read tells this run from the next one without a clock.
        self.assertTrue(run(table=FREE, bg="own", incognito=True)["out"][0]["armed"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the tab switcher's JavaScript")
class LiveTable(unittest.TestCase):
    def test_ctrl_tab_put_back_on_a_vivaldi_command_lets_go_at_once(self):
        out = run(table=FREE, bg="shared", stored={**DONE, "tabKeysFreed": True}, steps=["rebind", "press"])["out"]
        self.assertTrue(out[0]["armed"])
        self.assertFalse(out[1]["armed"])
        self.assertIn("COMMAND_TAB_SWITCH_FORWARD_SETTING", out[1]["reason"])
        self.assertFalse(out[2]["armed"])

    def test_keys_freed_by_hand_during_a_run_mark_that_run(self):
        out = run(table=HELD, bg="shared", stored={**DONE, "tabKeysFreed": True}, steps=["unbind", "press"])["out"]
        self.assertEqual([o["armed"] for o in out], [False, False, False])


if __name__ == "__main__":
    unittest.main()
