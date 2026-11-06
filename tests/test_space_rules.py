import json
import shutil
import subprocess
import unittest

from jsrun import JS_DIR, run_js


def js(expr, **data):
    return run_js("07-workspaces.js", expr, **data)


# Vivaldi's workspace store as 8.2 keeps it: the source of its module holds `getActiveWorkspaceId(e){`.
FAKE_RECORD = """
  const store = { getActiveWorkspaceId: (w) => (w === 7 ? 42 : undefined), getActiveWorkspaces: () => new Map([[42, 7]]) };
  const modules = {
    1: function () { return "nothing to see"; },
    2: function () { return "class X{getActiveWorkspaceId(e){return this.map.get(e)}}"; },
  };
  const exportsOf = { 2: { Z: store } };
  const require = (id) => { if (!(id in exportsOf)) throw new Error("not loaded: " + id); return exportsOf[id]; };
  require.m = modules;
  const chunks = { push: ([ids, extra, run]) => run(require) };
"""

# Loads 07 and 08 with a fake window; the background page's chunks come from installBg().
NATIVE_HARNESS = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const warns = [];
globalThis.console = { warn: (...a) => warns.push(a.map(String).join(" ")), log() {}, error() {} };
let now = 1000;
Date.now = () => now;
const advance = (ms) => { now += ms; };
const calls = [];
globalThis.bg = {};
globalThis.chrome = { windows: { update: async (id, opts) => { calls.push(["focus", id, opts]); } }, extension: { getBackgroundPage: () => globalThis.bg } };
globalThis.window = { __vm: {} };
const installBg = () => {
  const sw = { setActiveWorkspace: (w, s) => { calls.push(["switch", w, s === undefined ? "undef" : s]); return Promise.resolve(); } };
  const store = { getActiveWorkspaceId: (w) => (w === 7 ? 42 : undefined), getActiveWorkspaces: () => new Map([[42, 7]]) };
  const require = (id) => ({ 1: { A: sw }, 2: { Z: store } })[id];
  require.m = { 1: function () { return "setActiveWorkspace(e,t){}"; }, 2: function () { return "getActiveWorkspaceId(e){}"; } };
  globalThis.bg.webpackChunkgapp_browser_react = { push: ([a, b, run]) => run(require) };
};
for (const f of ["07-workspaces.js", "08-space-native.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
const native = window.__vm.native;
eval("(async () => {" + input.expr + "})()").then((v) => process.stdout.write(JSON.stringify(v === undefined ? null : v, (k, x) => (x === undefined ? null : x))));
"""


def native_js(expr):
    result = subprocess.run(["node", "-e", NATIVE_HARNESS, JS_DIR, json.dumps({"expr": expr})],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Record(unittest.TestCase):
    """Which space a window shows is read from Vivaldi's own record, found in its webpack modules."""

    def test_the_record_says_which_space_a_window_shows(self):
        out = js("(() => {" + FAKE_RECORD + "const r = workspaces.findRecord(chunks); return [r.activeIn(7), r.activeIn(8)]; })()")
        self.assertEqual(out, [42, 0], "a window with no entry is on the default space")

    def test_all_maps_each_space_to_its_window(self):
        out = js("(() => {" + FAKE_RECORD + "return [...workspaces.findRecord(chunks).all()]; })()")
        self.assertEqual(out, [[42, 7]])

    def test_no_store_means_no_record_not_an_error(self):
        self.assertIsNone(js("workspaces.findRecord(undefined)"))
        fake = """
          const require = (id) => ({ Z: {} });
          require.m = { 1: function () { return "unrelated"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertIsNone(js("(() => {" + fake + "return workspaces.findRecord(chunks); })()"))


    def test_a_store_that_throws_after_the_lookup_gives_a_fallback_not_an_error(self):
        fake = """
          const store = { getActiveWorkspaceId() { throw new Error("boom"); }, getActiveWorkspaces() { throw new Error("boom"); } };
          const require = () => ({ Z: store });
          require.m = { 1: function () { return "getActiveWorkspaceId(e){}"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        out = js("(() => {" + fake + "const r = workspaces.findRecord(chunks); return [r.activeIn(7), [...r.all()]]; })()")
        self.assertEqual(out, [None, []])

    def test_a_store_answering_something_odd_gives_no_space(self):
        fake = """
          const store = { getActiveWorkspaceId: () => ({ odd: 1 }), getActiveWorkspaces: () => new Map() };
          const require = () => ({ Z: store });
          require.m = { 1: function () { return "getActiveWorkspaceId(e){}"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertIsNone(js("(() => {" + fake + "return workspaces.findRecord(chunks).activeIn(7); })()"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Native(unittest.TestCase):
    """window.__vm.native: the record and the switch, looked up lazily, kept once found, retried at most every 5 s."""

    def test_the_record_comes_from_the_background_page(self):
        out = native_js("installBg(); const r = native.record(); return [r.activeIn(7), r.activeIn(9), [...r.all()]]")
        self.assertEqual(out, [42, 0, [[42, 7]]])

    def test_switching_to_the_default_space_gives_vivaldi_undefined(self):
        out = native_js("installBg(); await native.switchTo(7, 0); await native.switchTo(7, 42); return calls")
        self.assertEqual(out, [["switch", 7, "undef"], ["switch", 7, 42]])

    def test_focus_focuses_the_window(self):
        self.assertEqual(native_js("await native.focus(7); return calls"), [["focus", 7, {"focused": True}]])

    def test_a_missing_record_is_looked_for_again_only_after_five_seconds(self):
        out = native_js("""
          let looks = 0;
          const real = window.__vm.workspaces.findRecord;
          window.__vm.workspaces.findRecord = (c) => { if (c) looks++; return real(c); };
          globalThis.bg.webpackChunkgapp_browser_react = { push: ([a, b, run]) => run(Object.assign(() => ({}), { m: {} })) };
          const first = native.record(); advance(4000); const second = native.record();
          const early = looks;
          installBg(); advance(1500);
          const third = native.record(); const lookedAfter = looks;
          native.record(); native.record();
          return [first, second, early, third !== null, lookedAfter, looks];
        """)
        self.assertEqual(out, [None, None, 1, True, 2, 2], "one look, none inside 5 s, one after, then cached")

    def test_hasswitch_tells_callers_before_any_side_effect(self):
        self.assertEqual(native_js("const before = native.hasSwitch(); installBg(); advance(6000); return [before, native.hasSwitch()]"), [False, True])

    def test_switching_without_vivaldis_switch_rejects_instead_of_throwing(self):
        out = native_js("try { await native.switchTo(7, 42); return 'no error'; } catch (e) { return e.message; }")
        self.assertIn("unavailable", out)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class NoStamping(unittest.TestCase):
    def test_vivarc_never_stamps_a_space_onto_a_new_tab(self):
        # Vivaldi files every new tab in the window's recorded space itself (B1, B2b, B7c); Vivarc's own stamp undid switches (A8b)
        self.assertNotIn("stamp", js("Object.keys(workspaces)"))


if __name__ == "__main__":
    unittest.main()
