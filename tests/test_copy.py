"""Copy Link copies through a copy event, as Vivaldi's own UI does: navigator.clipboard rejects while the page's webview
has the focus, and the failure used to be swallowed (Task 9a; upstream KASOGIT/vivarc#153). The sandbox case
CL.copy-link-page-focused checks the real clipboard."""
import json
import shutil
import subprocess
import unittest

from jsrun import JS_DIR

# 00-core.js with a fake document: execCommand("copy") fires the copy event listeners (unless `noEvent`), each given a
# clipboardData that records what was set.
HARNESS = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const listeners = [];
const set = [];
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.indexedDB = { open: () => ({}) };
globalThis.document = {
  addEventListener: (type, fn) => { if (type === "copy") listeners.push(fn); },
  removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  execCommand: (cmd) => {
    if (input.throws) throw new Error("not allowed");
    if (cmd !== "copy" || input.noEvent) return false;
    const e = { clipboardData: { setData: (type, value) => set.push([type, value]) }, preventDefault() {}, stopPropagation() {} };
    for (const fn of [...listeners]) fn(e);
    return true;
  },
  querySelector: () => null, documentElement: { classList: { add() {} } },
};
globalThis.window = { __vmConfig: {}, addEventListener() {} };
globalThis.console = { warn() {}, log() {}, error() {} };
vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], "00-core.js"), "utf8"));
const done = window.__vm.copyText(input.text);
process.stdout.write(JSON.stringify({ done, set, left: listeners.length }));
"""


def copy(text, **opts):
    result = subprocess.run(["node", "-e", HARNESS, JS_DIR, json.dumps({"text": text, **opts})], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class CopyText(unittest.TestCase):
    def test_the_text_goes_on_the_clipboard_through_a_copy_event(self):
        self.assertEqual(copy("https://a.test/x"), {"done": True, "set": [["text/plain", "https://a.test/x"]], "left": 0})

    def test_its_listener_is_gone_afterwards_so_the_next_copy_is_the_users_own(self):
        self.assertEqual(copy("x")["left"], 0)
        self.assertEqual(copy("x", throws=True), {"done": False, "set": [], "left": 0})

    def test_it_says_when_nothing_was_copied(self):
        self.assertEqual(copy("x", noEvent=True)["done"], False)

    def test_the_menus_copy_link_uses_it(self):
        source = open(f"{JS_DIR}/10-sidebar.js", encoding="utf8").read()
        self.assertIn("const copy = (text) => window.__vm.copyText(text);", source)
        self.assertNotIn("navigator.clipboard?.writeText(text)", source)


if __name__ == "__main__":
    unittest.main()
