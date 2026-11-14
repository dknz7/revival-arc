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

    def test_recently_closed_leaves_out_only_the_entries_matched_to_closed_preview_tabs(self):
        sessions = [{"lastModified": 1000, "tab": {"url": "https://a.test/1", "sessionId": "1"}},
                    {"lastModified": 1000, "tab": {"url": "https://a.test/1", "sessionId": "2"}},  # the user's own tab, same address
                    {"lastModified": 1000, "window": {"sessionId": "w", "tabs": []}}]
        out = js("workspaces.withoutPeekClosed(s, ['1']).map((x) => x.tab?.sessionId ?? x.window.sessionId)", s=sessions)
        self.assertEqual(out, ["2", "w"])
        self.assertEqual(len(js("workspaces.withoutPeekClosed(s, [])", s=sessions)), 3)
        self.assertEqual(len(js("workspaces.withoutPeekClosed(s, [null, 5])", s=sessions)), 3)

    def test_closed_preview_tabs_claim_their_entries_only_when_the_count_matches(self):
        at = 1000 * 1000
        one = [{"lastModified": 1000, "tab": {"url": "https://a.test/1", "sessionId": "1"}},
               {"lastModified": 1000, "tab": {"url": "https://a.test/2", "sessionId": "2"}}]
        two = one + [{"lastModified": 1001, "tab": {"url": "https://a.test/1", "sessionId": "3"}}]
        closed = {"url": "https://a.test/1", "at": at + 500, "n": 1}
        self.assertEqual(js("workspaces.claimClosed(c, s, [])", c=closed, s=one), ["1"])
        self.assertEqual(js("workspaces.claimClosed(c, s, [])", c=closed, s=two), [], "one preview tab, two entries: a user tab may be among them")
        self.assertEqual(js("workspaces.claimClosed(c, s, [])", c={**closed, "n": 2}, s=two), ["1", "3"], "Peek's two tabs closed together")
        self.assertEqual(js("workspaces.claimClosed(c, s, ['3'])", c=closed, s=two), ["1"], "one already claimed leaves one")
        self.assertEqual(js("workspaces.claimClosed(c, s, [])", c={"url": "https://a.test/1", "at": at + 9000, "n": 1}, s=one), [], "too long ago")
        self.assertEqual(js("workspaces.claimClosed(c, s, [])", c={"url": "", "at": at, "n": 1}, s=one), [])

    def test_a_runtime_tab_peek_adopted_into_the_strip_is_the_users(self):
        self.assertFalse(js("workspaces.isPeekTab(t, new Set())", t=tab(12, ext={"arcPeekRuntime": {"webviewId": "p"}, "arcPeekAdopted": {"createdBy": "ArcPeek"}})))

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
const bg = { ...(input.bg || {}) };
globalThis.chrome = {
  extension: { getBackgroundPage: () => bg },
  windows: { getCurrent: async () => ({ id: 1 }) },
  // globalThis.sessionsLater: the first look finds nothing (Chromium has not listed the closed tab yet)
  sessions: { getRecentlyClosed: async () => { if (globalThis.sessionsLater) { globalThis.sessionsLater = false; return []; }
    return (input.sessions || []).map((x) => ({ ...x, lastModified: x.lastModified === "now" ? Date.now() / 1000 : x.lastModified })); } },
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


def peek_js(script, tabs, webviews=None, set_space_fails=False, sessions=None, bg=None):
    result = subprocess.run(["node", "-e", PEEK_HARNESS, JS_DIR, json.dumps({"script": script, "tabs": tabs, "webviews": webviews or [], "setSpaceFails": set_space_fails,
                                                                           "sessions": sessions or [], "bg": bg or {}})],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class PeekRuntime(unittest.TestCase):
    # window 1: the source tab 2 (space 5), its neighbours 1 and 3; Peek's preloaded tab 10 (stashed: default) and its
    # runtime tab 11.
    TABS = [tab(1, 1, 5, index=0), tab(2, 1, 5, index=1), tab(10, 1, 0, index=2), tab(3, 1, 5, index=3),
            tab(11, 1, 0, ext={"arcPeekRuntime": {"createdBy": "ArcPeek", "webviewId": "peek-1"}}, index=4)]
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

    PROMOTE_THEN_DISPOSE = ("await peek._moveParallelTabToMainWindow('peek-1');"
                            "await peek.disposePeek('peek-1', { animated: false, closeRuntimeTab: false, closeParallelTab: false });"
                            "await new Promise((r) => setTimeout(r, 600));")

    def test_the_runtime_tab_peek_leaves_after_open_in_new_tab_is_closed_and_its_entry_claimed(self):
        out = peek_js(self.PROMOTE_THEN_DISPOSE, self.TABS, self.PREVIEW,
                      sessions=[{"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "s11"}}])
        self.assertIn(["remove", 11], out["calls"])
        self.assertEqual(out["bg"]["__vivarcPeekClosed"], ["s11"], "its Recently Closed entry, by identity")

    def test_two_preview_tabs_of_one_address_closed_together_claim_both_entries(self):
        tabs = [t if t["id"] != 10 else {**t, "url": "https://site.test/11"} for t in self.TABS]
        script = ("await peek.disposePeek('peek-1', { closeRuntimeTab: true }); await chrome.tabs.remove(10); await chrome.tabs.remove(11);"
                  "await new Promise((r) => setTimeout(r, 600));")
        out = peek_js(script, tabs, self.PREVIEW, sessions=[{"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "a"}},
                                                           {"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "b"}}])
        self.assertEqual(sorted(out["bg"]["__vivarcPeekClosed"]), ["a", "b"])
        self.assertIn("vm-peek-changed", out["events"], "the sidebar lists the promoted tab again")

    def test_an_entry_listed_late_is_still_claimed(self):
        # Chromium lists the closed tab only after the first look: the claim looks again
        script = ("globalThis.sessionsLater = true;" + self.PROMOTE_THEN_DISPOSE.replace("600", "1800"))
        out = peek_js(script, self.TABS, self.PREVIEW, sessions=[{"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "late"}}])
        self.assertEqual(out["bg"].get("__vivarcPeekClosed"), ["late"])

    def test_claim_later_only_when_fewer_entries_than_closed_tabs(self):
        at = 1000 * 1000
        s1 = [{"lastModified": 1000, "tab": {"url": "u", "sessionId": "1"}}]
        self.assertEqual(js("[workspaces.claimLater(c1, [], []), workspaces.claimLater(c1, s, []), workspaces.claimLater(c2, s, []), workspaces.claimLater(c0, s, [])]",
                            c1={"url": "u", "at": at, "n": 1}, c2={"url": "u", "at": at, "n": 2}, c0={"url": "u", "at": at, "n": 0}, s=s1),
                         [True, False, True, False])

    def test_an_ambiguous_closed_entry_is_not_claimed(self):
        out = peek_js(self.PROMOTE_THEN_DISPOSE, self.TABS, self.PREVIEW,
                      sessions=[{"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "a"}},
                                {"lastModified": "now", "tab": {"url": "https://site.test/11", "sessionId": "b"}}])
        self.assertNotIn("__vivarcPeekClosed", out["bg"])

    def test_without_a_promotion_this_wrap_saw_nothing_is_closed(self):
        out = peek_js("await peek.disposePeek('peek-1', { closeRuntimeTab: false, closeParallelTab: false });", self.TABS, self.PREVIEW)
        self.assertNotIn(["remove", 11], out["calls"])

    def test_a_runtime_tab_of_another_preview_or_adopted_is_never_closed(self):
        other = [t if t["id"] != 11 else tab(11, 1, 0, ext={"arcPeekRuntime": {"webviewId": "peek-2"}}, index=4) for t in self.TABS]
        self.assertNotIn(["remove", 11], peek_js(self.PROMOTE_THEN_DISPOSE, other, self.PREVIEW)["calls"])
        adopted = [t if t["id"] != 11 else tab(11, 1, 0, ext={"arcPeekRuntime": {"webviewId": "peek-1"}, "arcPeekAdopted": {}}, index=4) for t in self.TABS]
        self.assertNotIn(["remove", 11], peek_js(self.PROMOTE_THEN_DISPOSE, adopted, self.PREVIEW)["calls"])

    def test_a_promoted_tab_is_listed_again_at_once(self):
        out = peek_js("await peek._moveParallelTabToMainWindow('peek-1'); calls.push(window.__vm.peek.without(tabs).map((t) => t.id));", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"][-1], [1, 2, 10, 3], "10 is the user's tab now; the runtime tab 11 is still the preview's")

    def test_another_windows_live_previews_are_left_out_here_too(self):
        tabs = self.TABS + [tab(30, 2, 0, index=0), tab(31, 2, 0, index=1)]
        out = peek_js("calls.push(window.__vm.peek.without(tabs).map((t) => t.id));", tabs, [], bg={"__vivarcPeekLive": {"other-window": [30]}})
        self.assertEqual(out["calls"][-1], [1, 2, 10, 3, 31], "30 is a preview of the other window; 11 is a runtime tab")

    def test_this_windows_previews_are_shared_with_the_others(self):
        out = peek_js("tabs.push({ id: 99, windowId: 1, index: 9, vivExtData: '{}', url: 'x' }); listeners.updated.forEach((f) => f(99, {}, tabs[tabs.length - 1]));", self.TABS, self.PREVIEW)
        self.assertEqual(sorted(next(iter(out["bg"]["__vivarcPeekLive"].values()))), [10, 11])

    def test_broken_peek_records_fail_open(self):
        out = peek_js("peek.webviews = { values() { throw new Error('changed'); }, get() { throw new Error('changed'); } }; calls.push(window.__vm.peek.without(tabs).map((t) => t.id));"
                      "await peek._moveParallelTabToMainWindow('peek-1'); await peek.disposePeek('peek-1', { closeRuntimeTab: false });", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"][0], [1, 2, 10, 3], "only the marked runtime tab is left out")
        self.assertNotIn(["remove", 11], out["calls"])

    def test_a_dispose_that_closes_its_own_tabs_closes_nothing_more(self):
        out = peek_js("await peek.disposePeek('peek-1', { closeRuntimeTab: true, closeParallelTab: true });", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"], [["peek-dispose", "peek-1", {"closeRuntimeTab": True, "closeParallelTab": True}]])

    def test_while_a_preview_is_open_its_tabs_are_left_out_of_the_lists(self):
        out = peek_js("globalThis.left = window.__vm.peek.without(tabs).map((t) => t.id); calls.push(left);", self.TABS, self.PREVIEW)
        self.assertEqual(out["calls"], [[1, 2, 3]])


if __name__ == "__main__":
    unittest.main()
