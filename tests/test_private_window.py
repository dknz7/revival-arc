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


if __name__ == "__main__":
    unittest.main()
