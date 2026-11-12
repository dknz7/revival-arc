"""A private window runs on an off-the-record profile: its Vivarc store starts empty, but vivaldi.prefs is the real profile's
(Task 8u). It must never set the profile up again, and it follows the normal windows' Dia layout without writing anything."""
import json
import os
import shutil
import subprocess
import unittest

JS = os.path.join(os.path.dirname(__file__), "..", "src", "js")

# 05-bootstrap.js (and 06-spaces.js's bottom bar) against fake prefs, an empty store and a window that is private or not.
SETUP = r'''
const fs = require("fs"), vm = require("vm");
const sc = JSON.parse(process.argv[2]);
const sets = [], prefs = { "vivaldi.actions": [{ COMMAND_SAVE_PAGE: { shortcuts: ["ctrl+s"] } }], "vivaldi.toolbars.tabbar_before": ["AddressField"],
  "vivaldi.toolbars.tabbar_after": ["AccountButton"], "vivaldi.tabs.bar.position": "top" };
const ev = { addListener() {} };
global.setTimeout = () => 0;
global.console = { log() {}, warn() {} };
global.chrome = { extension: { inIncognitoContext: sc.incognito },
  windows: { getCurrent: async () => ({ id: 1, type: "normal", incognito: sc.incognito }), getAll: async () => [{ id: 1, type: "normal", incognito: sc.incognito }] },
  tabs: { query: async () => [], update: async () => ({}), onCreated: ev, onUpdated: ev } };
global.vivaldi = { prefs: { get: async (path) => ({ value: prefs[path] }), set: async ({ path, value }) => { sets.push(path); prefs[path] = value; } } };
const stored = new Map();
global.window = { __vm: { config: { startUrl: "file:///guide.html" }, windows: true, shortcut: (c) => c,
  workspaces: { leaderOf: (wins) => wins[0]?.id },
  store: { get: async (k, f) => stored.get(k) ?? f, set: async (k, v) => { stored.set(k, v); } } } };
for (const file of ["05-bootstrap.js", "06-spaces.js"]) vm.runInThisContext(fs.readFileSync(require("path").join(process.argv[1], file), "utf8"));
(async () => {
  await window.__vm.spaces.syncBottomBar(false);
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  process.stdout.write(JSON.stringify({ sets, stored: [...stored.keys()] }) + "\n");
})();
'''


def setup_run(incognito):
    out = subprocess.run(["node", "-e", SETUP, JS, json.dumps({"incognito": incognito})], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the profile setup's JavaScript")
class ProfileSetup(unittest.TestCase):
    def test_a_normal_window_of_a_new_profile_sets_it_up(self):
        out = setup_run(False)  # the control: the fake can see the setup's writes
        for path in ("vivaldi.address_bar.visible", "vivaldi.tabs.bar.width", "vivaldi.auto_hide.enabled", "vivaldi.actions",
                     "vivaldi.tabs.bar.position", "vivaldi.toolbars.tabbar_after"):
            self.assertIn(path, out["sets"])
        self.assertIn("bootstrap", out["stored"])

    def test_a_private_window_writes_no_pref_and_records_no_setup(self):
        out = setup_run(True)
        self.assertEqual(out["sets"], [], "a private window's empty store is not a new profile")
        self.assertEqual(out["stored"], [])


# 01-settings.js and 15-dia.js together in one window: the store holds `saved`, Vivaldi's prefs hold `prefs`, the window is
# private or not. `then`: settings.set calls made afterwards. Reports the window's Dia value, every pref and store write,
# and every message to the other windows.
SETTINGS = r'''
const fs = require("fs"), vm = require("vm"), path = require("path");
const sc = JSON.parse(process.argv[2]);
const writes = [], posts = [], stored = new Map(sc.saved ? [["settings", sc.saved]] : []);
const prefs = { ...sc.prefs };
const changed = [];
global.console = { log() {}, warn() {} };
const node = () => ({ classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, style: { setProperty() {}, removeProperty() {} }, remove() {}, dataset: {} });
global.document = { body: node(), querySelector: () => null };
global.MutationObserver = class { observe() {} };
global.ResizeObserver = class { observe() {} unobserve() {} };
global.requestAnimationFrame = (fn) => fn();
global.BroadcastChannel = class { postMessage(m) { posts.push(m); } };
global.chrome = { extension: { inIncognitoContext: sc.incognito },
  windows: { getCurrent: async () => ({ id: 1, type: "normal", incognito: sc.incognito }) },
  tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onReplaced: { addListener() {} } } };
global.vivaldi = { prefs: { get: async (p) => ({ value: prefs[p] }), set: async ({ path: p, value }) => { writes.push(["pref", p]); prefs[p] = value; },
  onChanged: { addListener: (fn) => changed.push(fn) } } };
global.window = { __vm: { windows: true, onMark() {}, ready: Promise.resolve(true), config: {},
  store: { get: async (k, f) => stored.get(k) ?? f, set: async (k, v) => { writes.push(["store", k]); stored.set(k, v); } } },
  dispatchEvent() {}, innerWidth: 1000 };
for (const file of ["01-settings.js", "15-dia.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], file), "utf8"));
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
(async () => {
  await window.__vm.settings.loaded;
  await settle();
  const atOpen = window.__vm.settings.get("diaLayout");
  for (const [k, v] of sc.then || []) { if (k === "__reset") window.__vm.settings.reset(); else window.__vm.settings.set(k, v); await settle(); }
  if (sc.prefsLater) { Object.assign(prefs, sc.prefsLater); changed.forEach((fn) => fn({ path: "vivaldi.address_bar.visible" })); await new Promise((r) => setTimeout(r, 400)); await settle(); }
  process.stdout.write(JSON.stringify({ atOpen, now: window.__vm.settings.get("diaLayout"), glass: window.__vm.settings.get("glass"), writes, posts }) + "\n");
})();
'''
ADDRESS, ROW, FRAME = "vivaldi.address_bar.visible", "vivaldi.toolbars.navigation", "vivaldi.windows.use_native_decoration"
DIA_ON = {ADDRESS: True, ROW: ["Back", "Forward", "Reload", "FlexibleSpacer", "Extensions"], FRAME: False}
DIA_OFF = {ADDRESS: False, ROW: ["PanelToggle", "Back", "Forward", "Reload", "AddressField"], FRAME: True}


def settings_run(**scenario):
    out = subprocess.run(["node", "-e", SETTINGS, JS, json.dumps(scenario)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the settings' JavaScript")
class PrivateDia(unittest.TestCase):
    def test_a_private_window_opens_with_dia_when_the_profile_has_it(self):
        out = settings_run(incognito=True, prefs=DIA_ON)
        self.assertTrue(out["atOpen"])
        self.assertEqual(out["writes"], [])
        self.assertEqual(out["posts"], [])

    def test_and_without_it_when_the_profile_does_not(self):
        out = settings_run(incognito=True, prefs=DIA_OFF)
        self.assertFalse(out["atOpen"])
        self.assertEqual(out["writes"], [])

    def test_the_address_row_alone_is_not_the_dia_layout(self):
        out = settings_run(incognito=True, prefs={**DIA_OFF, ADDRESS: True})
        self.assertFalse(out["atOpen"])

    def test_a_dia_row_edited_in_vivaldis_toolbar_editor_still_counts(self):
        out = settings_run(incognito=True, prefs={**DIA_ON, ROW: ["Back", "Reload", "FlexibleSpacer", "Bookmarks"]})
        self.assertTrue(out["atOpen"])

    def test_the_users_own_address_bar_row_is_not_the_dia_layout_even_with_the_frame_off(self):
        out = settings_run(incognito=True, prefs={ADDRESS: True, ROW: ["Back", "Forward", "AddressField"], FRAME: False})
        self.assertFalse(out["atOpen"])

    def test_reset_in_a_private_window_keeps_the_normal_windows_layout(self):
        out = settings_run(incognito=True, prefs=DIA_ON, then=[["diaLayout", False], ["__reset", None]])
        self.assertTrue(out["now"])
        self.assertNotIn(["pref", ADDRESS], out["writes"])

    def test_toggling_it_in_a_private_window_is_this_windows_only_and_not_saved(self):
        out = settings_run(incognito=True, prefs=DIA_ON, then=[["diaLayout", False]])
        self.assertFalse(out["now"])
        self.assertEqual(out["writes"], [], "no store or pref write")
        self.assertEqual(out["posts"], [], "no message to the other windows")

    def test_other_settings_in_a_private_window_keep_their_usual_path(self):
        out = settings_run(incognito=True, prefs=DIA_ON, then=[["glass", True]])
        self.assertTrue(out["glass"])
        self.assertIn(["store", "settings"], out["writes"])

    def test_it_follows_the_normal_windows_until_toggled_here(self):
        out = settings_run(incognito=True, prefs=DIA_ON, prefsLater=DIA_OFF)
        self.assertTrue(out["atOpen"])
        self.assertFalse(out["now"])
        out = settings_run(incognito=True, prefs=DIA_OFF, then=[["diaLayout", True]], prefsLater=DIA_ON)
        self.assertTrue(out["now"])
        out = settings_run(incognito=True, prefs=DIA_ON, then=[["diaLayout", False]], prefsLater={**DIA_ON, ADDRESS: True})
        self.assertFalse(out["now"], "toggled here: the window keeps its own choice")

    def test_a_normal_window_uses_its_saved_setting_not_the_prefs(self):
        out = settings_run(incognito=False, prefs=DIA_ON, saved={})
        self.assertFalse(out["atOpen"])
        out = settings_run(incognito=False, prefs=DIA_OFF, saved={"diaLayout": True})
        self.assertTrue(out["atOpen"])


if __name__ == "__main__":
    unittest.main()
