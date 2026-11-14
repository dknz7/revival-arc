"""Peek on Vivaldi 8.3 (Task 9a, B1; upstream KASOGIT/vivarc#165/#166): its preview tabs stay out of Vivarc's lists, and a
preview made into a tab lands in the space on screen beside its source (src/js/17-peek.js, helpers in 07-workspaces.js)."""
import json
import shutil
import subprocess
import unittest

from jsrun import JS_DIR, run_js


def js(expr, **data):
    return run_js("07-workspaces.js", expr, **data)


def tab(id, window=1, space=0, ext=None, index=None):
    data = {**({"workspaceId": space} if space else {}), **(ext or {})}
    return {"id": id, "windowId": window, "index": id if index is None else index, "vivExtData": json.dumps(data), "url": f"https://site.test/{id}"}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class PeekTabs(unittest.TestCase):
    def test_the_open_previews_tabs_and_any_runtime_tab_are_peeks(self):
        # the ids Set is made in JS: a Set can't cross JSON
        self.assertEqual(js("""(() => { const ids = workspaces.peekIds([{ parallelTabId: 10, relatedTabId: null }, { parallelTabId: null, relatedTabId: 11 }]);
          return [workspaces.isPeekTab(a, ids), workspaces.isPeekTab(b, ids), workspaces.isPeekTab(c, ids), workspaces.isPeekTab(d, ids), workspaces.isPeekTab(e, new Set())]; })()""",
                            a=tab(10), b=tab(11), c=tab(12, ext={"arcPeekRuntime": {"createdBy": "ArcPeek"}}), d=tab(13, ext={"panelId": "x"}),
                            e=tab(14, ext={"arcPeekRuntime": {}})), [True, True, True, False, True])

    def test_a_preview_made_into_a_tab_is_the_users_again(self):
        # Peek drops the preview's record once it is done: its tab id is in no open preview
        self.assertFalse(js("workspaces.isPeekTab(t, workspaces.peekIds([]))", t=tab(10)))

    def test_unreadable_data_is_not_a_peek(self):
        self.assertFalse(js("workspaces.isPeekTab({ id: 1, vivExtData: '{oops' }, new Set())"))

    def test_recently_closed_leaves_out_what_peek_closed_within_five_seconds(self):
        sessions = [{"lastModified": 1000, "tab": {"url": "https://a.test/1", "sessionId": "1"}},
                    {"lastModified": 1000, "tab": {"url": "https://a.test/2", "sessionId": "2"}},
                    {"lastModified": 1100, "tab": {"url": "https://a.test/1", "sessionId": "3"}},  # the same page closed later by the user
                    {"lastModified": 1000, "window": {"sessionId": "w", "tabs": []}}]
        closed = [{"url": "https://a.test/1", "at": 1000 * 1000 + 3000}]
        out = js("workspaces.withoutPeekClosed(s, c).map((x) => x.tab?.sessionId ?? x.window.sessionId)", s=sessions, c=closed)
        self.assertEqual(out, ["2", "3", "w"])
        self.assertEqual(len(js("workspaces.withoutPeekClosed(s, [])", s=sessions)), 4)

    def test_beside_its_source_is_just_after_it(self):
        others = [tab(1, index=0), tab(2, index=1), tab(3, index=2)]
        self.assertEqual(js("[workspaces.besideSource(o, 2), workspaces.besideSource(o, 3), workspaces.besideSource(o, 9)]", o=others), [2, 3, None])


# Loads 07 and 17 with a fake Vivaldi window: window 1 shows space 5; Peek's instance arrives as window.ArcPeekDebug.
PEEK_HARNESS = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const calls = [], warns = [];
globalThis.console = { warn: (...a) => warns.push(a.map(String).join(" ")), log() {}, error() {} };
const tabs = input.tabs;
const listeners = { created: [], updated: [], removed: [] };
const bg = {};
globalThis.chrome = {
  extension: { getBackgroundPage: () => bg },
  windows: { getCurrent: async () => ({ id: 1 }) },
  tabs: {
    get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("no tab"); return t; },
    query: async ({ windowId }) => tabs.filter((t) => t.windowId === windowId),
    remove: async (id) => { calls.push(["remove", id]); const i = tabs.findIndex((t) => t.id === id); if (i >= 0) tabs.splice(i, 1); listeners.removed.forEach((f) => f(id)); },
    onCreated: { addListener: (f) => listeners.created.push(f) },
    onUpdated: { addListener: (f) => listeners.updated.push(f) },
    onRemoved: { addListener: (f) => listeners.removed.push(f) },
  },
};
const events = [];
globalThis.window = { __vm: {}, addEventListener: () => {}, dispatchEvent: (e) => events.push(e.type) };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
for (const f of ["07-workspaces.js", "17-peek.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
window.__vm.native = { record: () => ({ activeIn: () => 5 }),
  setSpace: async (id, space, opts) => { calls.push(["setSpace", id, space, opts]); if (input.setSpaceFails) throw new Error("refused"); } };
class FakePeek {
  constructor(webviews) { this.webviews = new Map(webviews); window.ArcPeekDebug = this; }
  async _moveParallelTabToMainWindow(id) { calls.push(["peek-move-back", id]); }
  async disposePeek(id, options) { calls.push(["peek-dispose", id, options]); this.webviews.delete(id); }
}
const peek = new FakePeek(input.webviews || []);
const run = async () => { await eval("(async () => {" + input.script + "})()"); };
run().then(() => setTimeout(() => process.stdout.write(JSON.stringify({ calls, warns, events, bg, same: window.ArcPeekDebug === peek })), 50),
  (e) => process.stdout.write(JSON.stringify({ error: String(e), calls, warns })));
"""


def peek_js(script, tabs, webviews=None, set_space_fails=False):
    result = subprocess.run(["node", "-e", PEEK_HARNESS, JS_DIR, json.dumps({"script": script, "tabs": tabs, "webviews": webviews or [], "setSpaceFails": set_space_fails})],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class PeekRuntime(unittest.TestCase):
    # window 1: the source tab 2 (space 5), its neighbours 1 and 3; Peek's preloaded tab 10 (stashed: default) and its
    # runtime tab 11.
    TABS = [tab(1, 1, 5, index=0), tab(2, 1, 5, index=1), tab(10, 1, 0, index=2), tab(3, 1, 5, index=3),
            tab(11, 1, 0, ext={"arcPeekRuntime": {"createdBy": "ArcPeek"}}, index=4)]
    PREVIEW = [["peek-1", {"parallelTabId": 10, "relatedTabId": 11, "tabId": 2, "_hiddenWorkspaceId": 6}]]

    def test_the_preview_tab_goes_into_the_space_on_screen_beside_its_source_before_peek_moves_it(self):
        out = peek_js("await peek._moveParallelTabToMainWindow('peek-1');", self.TABS, self.PREVIEW)
        self.assertTrue(out["same"], "window.ArcPeekDebug is still Peek's instance")
        # the others in order are 1, 2, 3, 11: just after the source (2) is index 2
        self.assertEqual(out["calls"], [["setSpace", 10, 5, {"windowId": 1, "index": 2}], ["peek-move-back", "peek-1"]])

    def test_a_refused_move_still_lets_peek_do_its_own(self):
        out = peek_js("await peek._moveParallelTabToMainWindow('peek-1');", self.TABS, self.PREVIEW, set_space_fails=True)
        self.assertEqual(out["calls"][-1], ["peek-move-back", "peek-1"])
        self.assertTrue(any("peek:" in w for w in out["warns"]))

    def test_no_preloaded_tab_means_nothing_moved(self):
        out = peek_js("await peek._moveParallelTabToMainWindow('peek-1');", self.TABS, [["peek-1", {"parallelTabId": None, "relatedTabId": 11, "tabId": 2}]])
        self.assertEqual(out["calls"], [["peek-move-back", "peek-1"]])

    def test_the_runtime_tab_peek_leaves_after_open_in_new_tab_is_closed_and_kept_out_of_recently_closed(self):
        out = peek_js("await peek.disposePeek('peek-1', { animated: false, closeRuntimeTab: false, closeParallelTab: false }); await new Promise((r) => setTimeout(r, 1100));",
                      self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"][-1], ["remove", 11])
        self.assertEqual([c["url"] for c in out["bg"]["__vivarcPeekClosed"]], ["https://site.test/11"], "what Recently Closed is filtered by")
        self.assertIn("vm-peek-changed", out["events"], "the sidebar lists the promoted tab again")

    def test_a_dispose_that_closes_its_own_tabs_closes_nothing_more(self):
        out = peek_js("await peek.disposePeek('peek-1', { closeRuntimeTab: true, closeParallelTab: true });", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"], [["peek-dispose", "peek-1", {"closeRuntimeTab": True, "closeParallelTab": True}]])

    def test_while_a_preview_is_open_its_tabs_are_left_out_of_the_lists(self):
        out = peek_js("globalThis.left = window.__vm.peek.without(tabs).map((t) => t.id); calls.push(left);", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"], [[1, 2, 3]])


if __name__ == "__main__":
    unittest.main()
