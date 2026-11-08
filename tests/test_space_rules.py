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
globalThis.fakeTabs = [];
globalThis.chrome = {
  windows: { update: async (id, opts) => { calls.push(["focus", id, opts]); } },
  extension: { getBackgroundPage: () => globalThis.bg },
  tabs: {
    get: async (id) => fakeTabs.find((t) => t.id === id),
    query: async ({ windowId } = {}) => fakeTabs.filter((t) => windowId == null || t.windowId === windowId),
    update: async (id, props) => { calls.push(["update", id, props]); },
    remove: async (id) => { calls.push(["remove", id]); },
    create: async (props) => { calls.push(["create", props]); return { id: 900, windowId: props.windowId }; },
  },
};
globalThis.window = { __vm: {} };
const installBg = () => {
  const sw = { setActiveWorkspace: (w, s) => { calls.push(["switch", w, s === undefined ? "undef" : s]); return Promise.resolve(); } };
  const store = { getActiveWorkspaceId: (w) => (w === 7 ? 42 : undefined), getActiveWorkspaces: () => new Map([[42, 7]]) };
  // Vivaldi's move: it lands the tab in the window and space asked for, unless globalThis.moveFails (it then reports
  // success and changes nothing, as the real one does for "ambiguous windowId").
  const actions = { ZP: { moveToWorkspace: (pages, space) => {
    calls.push(["move", pages, space]);
    const tab = fakeTabs.find((t) => t.id === pages.id);
    if (tab && !globalThis.moveFails) { tab.windowId = pages.windowId; tab.vivExtData = JSON.stringify(space ? { workspaceId: space } : {}); }
    return Promise.resolve();
  } } };
  const require = (id) => ({ 1: { A: sw }, 2: { Z: store }, 3: actions })[id];
  require.m = { 1: function () { return "setActiveWorkspace(e,t){}"; }, 2: function () { return "getActiveWorkspaceId(e){}"; },
    3: function () { return 'moveToWorkspace:Pe,debug:"PageActions.moveToWorkspace"'; } };
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

    def test_the_marker_does_not_depend_on_the_minifiers_parameter_name(self):
        # A rebuilt Vivaldi can rename the minified parameter: `getActiveWorkspaceId(t){` is the same store.
        renamed = FAKE_RECORD.replace("getActiveWorkspaceId(e){return this.map.get(e)}", "getActiveWorkspaceId(t){return this.map.get(t)}")
        self.assertNotEqual(renamed, FAKE_RECORD)
        out = js("(() => {" + renamed + "const r = workspaces.findRecord(chunks); return r && [r.activeIn(7), r.activeIn(8)]; })()")
        self.assertEqual(out, [42, 0])

    def test_a_module_that_only_calls_getactiveworkspaceid_is_not_the_store(self):
        fake = """
          const require = (id) => { throw new Error("must not be loaded: " + id); };
          require.m = { 1: function () { return "x.getActiveWorkspaceId(e)&&y()"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertIsNone(js("(() => {" + fake + "return workspaces.findRecord(chunks); })()"))


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


def in_window(window_id, workspace, id):
    return {"id": id, "windowId": window_id, "vivExtData": json.dumps({"workspaceId": workspace} if workspace else {})}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class BarPick(unittest.TestCase):
    """A tab picked in the command bar is shown with its space, never activated as a stray (G1): window 1 shows space 5."""

    def pick(self, tab, shown=5, shown_in=None):
        return js("workspaces.tabPick(tab, shown, shownIn)", tab=tab, shown=shown, shownIn=shown_in)

    def test_a_tab_of_the_space_on_screen_is_just_activated(self):
        self.assertEqual(self.pick(in_window(1, 5, 10)), {"kind": "activate"})

    def test_a_tab_parked_in_its_window_switches_the_window_to_its_space_first(self):
        self.assertEqual(self.pick(in_window(1, 6, 10)), {"kind": "switch", "window": 1, "space": 6})

    def test_a_default_tab_parked_in_its_window_switches_it_to_default(self):
        self.assertEqual(self.pick(in_window(1, 0, 10)), {"kind": "switch", "window": 1, "space": 0})

    def test_a_tab_whose_space_is_shown_in_another_window_goes_to_that_window(self):
        # a stray of a split space: go where the space is shown, as a tile click does; repair 3 gathers the stray
        self.assertEqual(self.pick(in_window(1, 6, 10), shown_in=2), {"kind": "focus", "window": 2})

    def test_without_the_record_the_tab_is_activated_as_before(self):
        self.assertEqual(self.pick(in_window(1, 6, 10), shown=None), {"kind": "activate"})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class LivesIn(unittest.TestCase):
    """A space lives where Vivaldi's record shows it; parked, where most of its tabs are. A dot marks a space living elsewhere."""

    def lives(self, tabs, record, space):
        return js("workspaces.livesIn(tabs, new Map(record), id)", tabs=tabs, record=record, id=space)

    def dots(self, tabs, record, here):
        return js("workspaces.dotsFor(tabs, new Map(record), here)", tabs=tabs, record=record, here=here)

    def test_shown_in_a_window_lives_there(self):
        tabs = [in_window(1, 5, 10), in_window(2, 5, 11), in_window(2, 5, 12)]
        self.assertEqual(self.lives(tabs, [[5, 1]], 5), 1, "the record beats the tab count")

    def test_parked_lives_where_its_tabs_are(self):
        self.assertEqual(self.lives([in_window(3, 5, 10), in_window(1, 6, 11)], [], 5), 3)

    def test_split_lives_where_it_is_shown_else_with_most_tabs_ties_to_lowest_window(self):
        split = [in_window(2, 5, 10), in_window(2, 5, 11), in_window(4, 5, 12)]
        self.assertEqual(self.lives(split, [[5, 4]], 5), 4)
        self.assertEqual(self.lives(split, [], 5), 2)
        tie = [in_window(4, 5, 10), in_window(2, 5, 11)]
        self.assertEqual(self.lives(tie, [], 5), 2)

    def test_no_tabs_lives_nowhere(self):
        self.assertIsNone(self.lives([in_window(1, 6, 10)], [], 5))
        self.assertIsNone(self.lives([], [], 5))

    def test_the_default_space_lives_nowhere(self):
        self.assertIsNone(self.lives([in_window(1, 0, 10)], [[0, 1]], 0))

    def shown(self, active_tabs, record, space):
        return js("workspaces.shownIn(tabs, record === null ? null : new Map(record), id)", tabs=active_tabs, record=record, id=space)

    def test_the_record_says_which_window_shows_a_space(self):
        active = [in_window(1, 5, 10), in_window(2, 6, 11)]
        self.assertEqual(self.shown(active, [[6, 2]], 6), 2)
        self.assertIsNone(self.shown(active, [[6, 2]], 5), "the record wins over the active tab: 5 is parked")

    def test_with_no_record_the_window_whose_active_tab_is_in_the_space_shows_it(self):
        active = [in_window(1, 5, 10), in_window(2, 6, 11)]
        self.assertEqual(self.shown(active, None, 6), 2)
        self.assertIsNone(self.shown(active, None, 7))
        self.assertIsNone(self.shown(active, None, 0))

    def test_with_no_record_a_shown_space_still_lives_in_the_window_holding_its_tabs(self):
        self.assertEqual(self.lives([in_window(2, 6, 11), in_window(2, 6, 12), in_window(1, 6, 13)], [], 6), 2)

    def test_dots_are_spaces_living_in_other_windows_shown_or_parked(self):
        tabs = [in_window(1, 5, 10), in_window(2, 6, 11), in_window(3, 7, 12), in_window(1, 8, 13), in_window(1, 0, 14)]
        # 5 shown here, 6 shown in 2, 7 parked in 3, 8 parked here, default never
        self.assertEqual(self.dots(tabs, [[5, 1], [6, 2]], 1), [6, 7])
        self.assertEqual(self.dots([], [], 1), [])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class TileGestures(unittest.TestCase):
    """One test per row of the spec's gesture table: what a click, shift+click and the new-window gesture do. Window 1 is 'here'."""

    def act(self, tabs, record, space, **gesture):
        flags = {"shift": False, "newWindow": False, **gesture}
        return js("workspaces.tileAction({ id, here: 1, tabs, record: new Map(record), shift: s, newWindow: n })",
                  id=space, tabs=tabs, record=record, s=flags["shift"], n=flags["newWindow"])

    def check(self, tabs, record, space, click, shift, new_window=None):
        def norm(kind, window=None):
            return {"kind": kind, "window": window}

        def got(**g):
            r = self.act(tabs, record, space, **g)
            return {"kind": r["kind"], "window": r.get("window")}
        self.assertEqual(got(), norm(*click), "click")
        self.assertEqual(got(shift=True), norm(*shift), "shift+click")
        if new_window:
            self.assertEqual(got(shift=True, newWindow=True), norm(*new_window), "new window")

    def test_shown_here(self):
        tabs = [in_window(1, 5, 10)]
        self.check(tabs, [[5, 1]], 5, ("none",), ("none",), ("new-window",))

    def test_shown_in_another_window(self):
        tabs = [in_window(2, 5, 10), in_window(1, 0, 11)]
        self.check(tabs, [[5, 2]], 5, ("focus", 2), ("pull",), ("new-window",))

    def test_parked_here(self):
        tabs = [in_window(1, 5, 10), in_window(1, 6, 11)]
        self.check(tabs, [[6, 1]], 5, ("show",), ("show",), ("new-window",))

    def test_parked_in_another_window(self):
        tabs = [in_window(2, 5, 10), in_window(1, 0, 11)]
        self.check(tabs, [[7, 2]], 5, ("show-there", 2), ("pull",), ("new-window",))

    def test_split_and_shown_in_another_window(self):
        tabs = [in_window(2, 5, 10), in_window(1, 5, 11), in_window(1, 5, 12)]
        self.check(tabs, [[5, 2]], 5, ("focus", 2), ("pull",))

    def test_split_and_shown_nowhere_goes_to_the_window_with_most_tabs(self):
        tabs = [in_window(2, 5, 10), in_window(2, 5, 11), in_window(1, 5, 12)]
        self.check(tabs, [[6, 1]], 5, ("show-there", 2), ("pull",))

    def test_empty(self):
        tabs = [in_window(1, 6, 10)]
        self.check(tabs, [[6, 1]], 5, ("show",), ("show",), ("new-window",))

    def test_default_space(self):
        tabs = [in_window(1, 5, 10), in_window(1, 0, 11)]
        self.check(tabs, [[5, 1]], 0, ("show",), ("show",), ("none",))
        self.check(tabs, [[5, 2]], 0, ("none",), ("none",), ("none",))

    def test_record_missing_and_the_tabs_say_it_is_active_here(self):
        active = dict(in_window(1, 5, 10), active=True)
        self.check([active, in_window(2, 0, 11)], [], 5, ("none",), ("none",))

    def test_record_missing_and_the_tabs_say_it_is_active_in_another_window(self):
        active = dict(in_window(2, 5, 10), active=True)
        self.check([active, in_window(2, 5, 12), in_window(1, 0, 11)], [], 5, ("focus", 2), ("pull",))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Pins(unittest.TestCase):
    """Favorites and pinned tabs open in the space on screen: window 1 is 'here', space 5 is shown there."""

    def act(self, tab, shown=5):
        return js("workspaces.pinAction(tab, 1, shown)", tab=tab, shown=shown)

    def test_a_pin_open_in_this_space_is_just_activated(self):
        self.assertEqual(self.act(in_window(1, 5, 10)), {"kind": "activate", "tab": 10})

    def test_a_pin_parked_in_another_space_is_brought_into_the_space_on_screen(self):
        self.assertEqual(self.act(in_window(1, 6, 10)), {"kind": "bring", "tab": 10})
        tab = dict(in_window(1, 6, 10), vivExtData='{"workspaceId":6,"vivarcPin":"77"}')
        self.assertEqual(js("JSON.parse(workspaces.restamp(tab, 5))", tab=tab), {"workspaceId": 5, "vivarcPin": "77"})

    def test_a_pin_in_another_window_is_brought_here(self):
        self.assertEqual(self.act(in_window(2, 5, 10)), {"kind": "bring", "tab": 10})

    def test_an_unopened_pin_opens_a_tab(self):
        self.assertEqual(self.act(None), {"kind": "open"})

    def test_bringing_into_the_default_space_removes_the_key(self):
        # Vivaldi merges vivExtData writes (measured): omitting workspaceId leaves the old space, writing 0 removes the key.
        self.assertEqual(self.act(in_window(1, 6, 10), shown=0), {"kind": "bring", "tab": 10})
        tab = dict(in_window(1, 6, 10), vivExtData='{"workspaceId":6,"vivarcPin":"77"}')
        self.assertEqual(js("JSON.parse(workspaces.restamp(tab, 0))", tab=tab), {"workspaceId": 0, "vivarcPin": "77"})
        self.assertEqual(js("workspaces.of({ vivExtData: workspaces.restamp(tab, 0) })", tab=tab), 0)
        self.assertEqual(self.act(in_window(1, 0, 10), shown=0), {"kind": "activate", "tab": 10})

    def test_with_several_bound_tabs_the_one_here_in_the_shown_space_wins_then_the_most_recent(self):
        a = dict(in_window(2, 5, 1), lastAccessed=900)
        b = dict(in_window(1, 5, 2), lastAccessed=100)
        c = dict(in_window(1, 6, 3), lastAccessed=500)
        d = dict(in_window(2, 6, 4), lastAccessed=800)
        self.assertEqual(js("workspaces.pickBound(t, 1, 5).id", t=[a, b, c, d]), 2)
        self.assertEqual(js("workspaces.pickBound(t, 1, 5).id", t=[a, c, d]), 1)
        self.assertIsNone(js("workspaces.pickBound(t, 1, 5)", t=[]))


# Vivaldi's measured effects (spec Part 1) applied to a snapshot, so a plan can be checked against the state it leaves.
#   switch to 0: nothing when the window is already on default (A8c); else its record entry goes and its most recent
#     default tab is activated, or a default start page is made when it has none (A8a, A8b).
#   switch to X: nothing when X is active in any window (A1, A2); else every X tab moves into the window (at the
#     start), the record becomes X and X's most recent tab is activated, or a start page tagged X is made (A3-A7).
#   activate: the tab becomes active; the record does not change (G1).
#   gather (chrome.tabs.move): the tab keeps its space and lands at the end, inactive; the target's record does not
#     change (C1). A window losing its active tab activates the tab to its right, else to its left (C4); a window
#     left with no tab closes, and its record entry with it.
APPLY = """
const applyPlan = (snap, plan) => {
  const of = workspaces.of;
  const tabs = snap.tabs.map((t) => ({ ...t }));
  let windows = snap.windows.map((w) => ({ ...w }));
  const record = new Map(snap.record);
  let clock = Math.max(0, ...tabs.map((t) => t.lastAccessed || 0));
  let nextId = Math.max(0, ...tabs.map((t) => t.id)) + 1000;
  const inWin = (w) => tabs.filter((t) => t.windowId === w).sort((a, b) => a.index - b.index);
  const reindex = (w) => inWin(w).forEach((t, i) => { t.index = i; });
  const activate = (t) => { for (const o of tabs) if (o.windowId === t.windowId) o.active = false; t.active = true; t.lastAccessed = ++clock; };
  const recent = (w, s) => inWin(w).filter((t) => of(t) === s).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  const make = (w, s) => { const t = { id: nextId++, windowId: w, index: inWin(w).length, vivExtData: s ? JSON.stringify({ workspaceId: s }) : "{}" }; tabs.push(t); activate(t); };
  const recordedIn = (w) => { for (const [s, x] of record) if (x === w) return s; return 0; };
  const leave = (t, to, index) => {
    const from = t.windowId, rest = inWin(from).filter((o) => o !== t);
    if (t.active && rest.length) activate(rest.find((o) => o.index > t.index) || rest[rest.length - 1]);
    t.active = false; t.windowId = to; t.index = index;
    reindex(from); reindex(to);
    if (!rest.length) {
      windows = windows.filter((w) => w.id !== from);
      for (const [s, x] of [...record]) if (x === from) record.delete(s);
    }
  };
  for (const a of plan) {
    if (a.kind === "switch" && !a.space) {
      const cur = recordedIn(a.window);
      if (!cur) continue;
      record.delete(cur);
      const d = recent(a.window, 0);
      d ? activate(d) : make(a.window, 0);
    } else if (a.kind === "switch") {
      if (record.has(a.space)) continue;
      record.delete(recordedIn(a.window));
      for (const t of tabs.filter((t) => of(t) === a.space && t.windowId !== a.window)) leave(t, a.window, -1);
      record.set(a.space, a.window);
      const r = recent(a.window, a.space);
      r ? activate(r) : make(a.window, a.space);
    } else if (a.kind === "activate") {
      activate(tabs.find((t) => t.id === a.tab));
    } else if (a.kind === "gather") {
      for (const id of a.tabs) leave(tabs.find((t) => t.id === id), a.window, 1e6);
    }
  }
  return { windows, tabs, record, spaces: snap.spaces };
};
"""


def tab(id, window, space, active=False, last=0, index=None):
    return {"id": id, "windowId": window, "index": id if index is None else index, "active": active, "lastAccessed": last,
            "vivExtData": json.dumps({"workspaceId": space} if space else {})}


def normal(*ids):
    return [{"id": i, "type": "normal"} for i in ids]


X, Y, Z = 5, 6, 7


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Repairs(unittest.TestCase):
    """Spec Part 2, "Repairs": Vivaldi can leave a window's record and screen disagreeing, or a space split across
    windows; the plan says how Vivarc puts it right. Space ids: X=5, Y=6, Z=7."""

    def plan(self, snap):
        return js("workspaces.repairPlan({ ...s, record: new Map(s.record) })", s=snap)

    def after(self, snap, passes=1):
        """The plan carried out on the snapshot `passes` times (Part 1's effects), then planned once more."""
        return js("(() => {" + APPLY + """
          let state = { ...s, record: new Map(s.record) };
          for (let i = 0; i < n; i++) state = applyPlan(state, workspaces.repairPlan(state));
          return workspaces.repairPlan(state);
        })()""", s=snap, n=passes)

    # ---- the snapshots, one per Vivaldi case ----
    F2 = {  # X active in window 2 (the other window) when it was deleted: its tabs closed, 2 still recorded on X
        "windows": normal(1, 2), "spaces": [Y],
        "record": [[X, 2]],
        "tabs": [tab(10, 1, 0, active=True), tab(20, 2, 0, active=True)],
    }
    C3 = {  # X's only tab moved from 1 to 2: 1 still recorded on X, showing its default tab; the tab parked in 2
        "windows": normal(1, 2), "spaces": [X],
        "record": [[X, 1]],
        "tabs": [tab(10, 1, 0, active=True), tab(20, 2, 0, active=True), tab(21, 2, X)],
    }
    D1 = {  # X's only tab closed with tabs.remove: 1 still recorded on X, showing its default tab
        "windows": normal(1), "spaces": [X],
        "record": [[X, 1]],
        "tabs": [tab(10, 1, 0, active=True, last=5)],
    }
    G1 = {  # window 1 on default, a parked X tab activated with tabs.update: the record stayed on default
        "windows": normal(1), "spaces": [X],
        "record": [],
        "tabs": [tab(10, 1, 0, last=100), tab(11, 1, 0, last=200), tab(12, 1, X, active=True, last=300)],
    }
    G1_NAMED = {  # window 1 on Y, a parked X tab activated: Y's most recent tab comes back
        "windows": normal(1), "spaces": [X, Y],
        "record": [[Y, 1]],
        "tabs": [tab(10, 1, Y, last=300), tab(11, 1, Y, last=100), tab(12, 1, X, active=True, last=400), tab(13, 1, 0, last=350)],
    }
    FOLLOW = {  # window 1 on default with no default tab (its last one closed), showing a parked X tab
        "windows": normal(1), "spaces": [X, Y],
        "record": [],
        "tabs": [tab(10, 1, X, active=True, last=100), tab(11, 1, Y, last=50)],
    }
    G6 = {  # window 1 on X, its active (and only X) tab restamped to Y while Y is active in window 2
        "windows": normal(1, 2), "spaces": [X, Y],
        "record": [[X, 1], [Y, 2]],
        "tabs": [tab(10, 1, 0, last=10), tab(11, 1, Y, active=True, last=90), tab(20, 2, Y, active=True, last=80)],
    }
    G6_DEFAULT = {  # window 1 on default with no default tab, showing a Y tab while Y is active in window 2
        "windows": normal(1, 2), "spaces": [Y, Z],
        "record": [[Y, 2]],
        "tabs": [tab(10, 1, Y, active=True, last=90), tab(11, 1, Z, last=10), tab(20, 2, Y, active=True, last=80)],
    }
    D8 = {  # X shown in 1; window 3 closed and its parked X tab rehomed into 2 (the last focused), at the start
        "windows": normal(1, 2), "spaces": [X],
        "record": [[X, 1]],
        "tabs": [tab(10, 1, X, active=True), tab(30, 2, X, index=0), tab(20, 2, 0, active=True, index=1)],
    }
    SPLIT_PARKED = {  # X shown nowhere: one tab in 1, two in 2
        "windows": normal(1, 2), "spaces": [X],
        "record": [],
        "tabs": [tab(10, 1, 0, active=True), tab(11, 1, X), tab(20, 2, 0, active=True), tab(21, 2, X), tab(22, 2, X)],
    }
    CONSISTENT = {  # 1 shows X with Y and default tabs parked; 2 shows default with a parked Z; 3 is a popup
        "windows": normal(1, 2) + [{"id": 3, "type": "popup"}], "spaces": [X, Y, Z],
        "record": [[X, 1]],
        "tabs": [tab(10, 1, X, active=True), tab(11, 1, X), tab(12, 1, Y), tab(13, 1, 0),
                 tab(20, 2, 0, active=True), tab(21, 2, Z), tab(30, 3, 0, active=True)],
    }
    TANGLE = {  # all at once: 1 on a deleted space, 2 drifted (G1), X split across 2 and 3, Z split across 1 and 3
        "windows": normal(1, 2, 3), "spaces": [X, Y, Z],
        "record": [[9, 1], [Y, 3]],
        "tabs": [tab(10, 1, 0, active=True), tab(11, 1, Z),
                 tab(20, 2, 0, last=10), tab(21, 2, X, active=True, last=50),
                 tab(30, 3, Y, active=True), tab(31, 3, X), tab(32, 3, Z)],
    }

    def test_a_window_on_a_deleted_space_goes_to_default(self):
        self.assertEqual(self.plan(self.F2), [{"kind": "switch", "window": 2, "space": 0}])

    def test_a_window_with_no_tab_of_its_space_goes_to_default(self):
        self.assertEqual(self.plan(self.C3), [{"kind": "switch", "window": 1, "space": 0}], "C3: the moved tab stays parked in 2")
        self.assertEqual(self.plan(self.D1), [{"kind": "switch", "window": 1, "space": 0}])

    def test_an_active_tab_of_another_space_hands_back_to_the_recorded_space(self):
        self.assertEqual(self.plan(self.G1), [{"kind": "activate", "tab": 11}], "the most recent default tab")
        self.assertEqual(self.plan(self.G1_NAMED), [{"kind": "activate", "tab": 10}], "the most recent Y tab")

    def test_with_no_tab_of_the_recorded_space_the_record_follows_the_active_tab(self):
        self.assertEqual(self.plan(self.FOLLOW), [{"kind": "switch", "window": 1, "space": X}])

    def test_but_not_onto_a_space_shown_in_another_window(self):
        # G6: window 1 goes to default (it holds no X tab any more), and the Y tab joins Y where it is shown
        self.assertEqual(self.plan(self.G6), [{"kind": "switch", "window": 1, "space": 0},
                                              {"kind": "gather", "space": Y, "window": 2, "tabs": [11]}])
        # Already on default, a switch to default would do nothing (A8c) and one to Y would only focus 2 (A2): the
        # Y tab is gathered into 2, and the next pass shows what window 1 is left showing.
        self.assertEqual(self.plan(self.G6_DEFAULT), [{"kind": "gather", "space": Y, "window": 2, "tabs": [10]}])

    def test_a_split_space_is_gathered_where_it_is_shown(self):
        self.assertEqual(self.plan(self.D8), [{"kind": "gather", "space": X, "window": 1, "tabs": [30]}])

    def test_a_split_space_shown_nowhere_gathers_where_most_tabs_are(self):
        self.assertEqual(self.plan(self.SPLIT_PARKED), [{"kind": "gather", "space": X, "window": 2, "tabs": [11]}])

    def test_a_consistent_state_needs_no_repair(self):
        self.assertEqual(self.plan(self.CONSISTENT), [])
        self.assertEqual(self.plan({"windows": [], "tabs": [], "record": [], "spaces": []}), [])

    def test_the_state_a_plan_leaves_needs_no_further_repair(self):
        self.assertEqual(self.plan(self.TANGLE), [
            {"kind": "switch", "window": 1, "space": 0},
            {"kind": "activate", "tab": 20},
            {"kind": "gather", "space": X, "window": 2, "tabs": [31]},
            {"kind": "gather", "space": Z, "window": 1, "tabs": [32]},
        ])
        for name in ["F2", "C3", "D1", "G1", "G1_NAMED", "FOLLOW", "G6", "D8", "SPLIT_PARKED", "CONSISTENT", "TANGLE"]:
            with self.subTest(name):
                self.assertEqual(self.after(getattr(self, name)), [], "one pass leaves nothing to repair")
        # the one case a pass can't finish: what window 1 shows once its active tab leaves is Vivaldi's pick
        self.assertNotEqual(self.after(self.G6_DEFAULT), [])
        self.assertEqual(self.after(self.G6_DEFAULT, passes=2), [], "two passes, inside the cap of 3")

    def test_one_leader_the_lowest_normal_window(self):
        leader = lambda wins: js("workspaces.leaderOf(w)", w=wins)
        self.assertEqual(leader(normal(4)), 4)
        self.assertEqual(leader(normal(9, 4)), 4)
        self.assertEqual(leader(normal(12, 9, 30)), 9)
        self.assertEqual(leader([{"id": 2, "type": "popup"}, {"id": 3, "type": "devtools"}] + normal(8)), 8, "only a normal window leads")
        self.assertIsNone(leader([{"id": 2, "type": "popup"}]))
        self.assertIsNone(leader([]))

    def test_a_closed_leader_is_replaced(self):
        wins = normal(3, 7, 5)
        self.assertEqual(js("workspaces.leaderOf(w)", w=wins), 3)
        self.assertEqual(js("workspaces.leaderOf(w.filter((x) => x.id !== 3))", w=wins), 5)
        self.assertEqual(js("workspaces.leaderOf(w.filter((x) => x.id === 7))", w=wins), 7)


# Loads 07 and 11 in one window (`me`) over a browser that never changes: whatever a repair does, the next snapshot is
# the same, the worst case for a loop. Timers run 40x fast; the 3 s poll is off.
RUNTIME_HARNESS = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const s = input.state, calls = [], log = [];
const realTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => realTimeout(fn, (ms || 0) / 40);
globalThis.setInterval = () => 0;
globalThis.console = { log: (...a) => log.push(a.map(String).join(" ")), warn: (...a) => log.push("WARN " + a.map(String).join(" ")), error() {} };
const bg = { ...(input.bg || {}) }; // Vivaldi's background page, which every window shares
const t0 = Date.now(), firstAt = [];
const call = (c) => { if (!calls.length) firstAt.push(Date.now() - t0); calls.push(c); };
const on = () => ({ addListener() {} });
globalThis.chrome = {
  extension: { getBackgroundPage: () => bg },
  windows: { getAll: async () => s.windows, getCurrent: async () => ({ id: input.me }), onRemoved: on("windows.onRemoved") },
  tabs: { query: async () => s.tabs,
          update: async (id) => { call(["activate", id]); },
          move: async (ids, p) => { call(["move", ids, p.windowId]); },
          onActivated: on("tabs.onActivated"), onAttached: on("tabs.onAttached"), onDetached: on("tabs.onDetached"), onRemoved: on("tabs.onRemoved") },
};
globalThis.vivaldi = { prefs: { get: async () => ({ value: s.spaces.map((id) => ({ id })) }) } };
globalThis.window = { addEventListener() {}, __vm: { ready: Promise.resolve(true) } };
for (const f of ["07-workspaces.js", "11-space-repair.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
const rec = new Map(s.record);
window.__vm.native = { hasSwitch: () => true, switchTo: async (w, sp) => { call(["switch", w, sp]); },
  record: () => ({ all: () => rec, activeIn: (w) => [...rec].find(([, x]) => x === w)?.[0] ?? 0 }) };
const repair = window.__vm.spaceRepair, later = (ms) => new Promise((r) => realTimeout(r, ms));
eval(input.script || "");
realTimeout(() => { process.stdout.write(JSON.stringify({ calls, log, firstAt: firstAt[0] ?? null, bg })); process.exit(0); }, 700);
"""


def runtime(state, me, bg=None, script=""):
    result = subprocess.run(["node", "-e", RUNTIME_HARNESS, JS_DIR, json.dumps({"state": state, "me": me, "bg": bg or {}, "script": script})],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class RepairRuntime(unittest.TestCase):
    """11-space-repair.js: only the leader acts, a run stops after 3 passes, and a move under way makes it wait."""

    def test_only_the_leader_repairs(self):
        self.assertEqual(runtime(Repairs.D8, me=2)["calls"], [], "window 2 is not the leader")
        out = runtime(Repairs.D8, me=1)
        self.assertEqual(out["calls"][0], ["move", [30], 1])
        self.assertIn("[vivarc] repair: gather space 5 into window 1 (tabs 30)", out["log"])

    def test_a_repair_that_does_not_take_stops_after_three_passes(self):
        out = runtime(Repairs.D1, me=1)
        self.assertEqual(out["calls"], [["switch", 1, 0]] * 3)
        self.assertEqual(len([line for line in out["log"] if line.startswith("[vivarc] repair: window 1")]), 3)
        self.assertTrue(any("still drifting" in line for line in out["log"]))

    def test_a_move_under_way_in_any_window_holds_repairs_off(self):
        import time
        # another window's gesture: its mark on the shared background page
        busy = {"__vivarcSpaceGesture": int(time.time() * 1000) + 9000}
        self.assertEqual(runtime(Repairs.D1, me=1, bg=busy)["calls"], [])
        stale = {"__vivarcSpaceGesture": int(time.time() * 1000) + 60000}
        self.assertEqual(runtime(Repairs.D1, me=1, bg=stale)["calls"][:1], [["switch", 1, 0]], "a mark beyond 10 s is ignored")
        # this window's gesture: marked until it ends, then repairs run
        out = runtime(Repairs.D1, me=1, script="const end = repair.gesture(); later(250).then(end);")
        self.assertEqual(out["calls"][:1], [["switch", 1, 0]])
        self.assertGreaterEqual(out["firstAt"], 250)
        self.assertEqual(out["bg"], {}, "the mark is gone once the gesture ends")

    def test_overlapping_gestures_each_keep_the_guard_until_the_last_ends(self):
        # a drop into this window while another gesture runs: the first to end (even twice) must not drop the other's guard
        out = runtime(Repairs.D1, me=1, script="const a = repair.gesture(), b = repair.gesture(); b(); b(); later(250).then(a);")
        self.assertEqual(out["calls"][:1], [["switch", 1, 0]])
        self.assertGreaterEqual(out["firstAt"], 250, "repairs waited for the gesture still running")
        self.assertEqual(out["bg"], {}, "all marks are gone once every gesture has ended")

    def test_a_gesture_never_taken_releases_nothing(self):
        import time
        busy = {"__vivarcSpaceGesture": int(time.time() * 1000) + 9000}
        out = runtime(Repairs.D1, me=1, bg=busy, script="const end = repair.gesture(); end(); end();")
        self.assertEqual(out["calls"], [], "another gesture's mark still holds repairs off")


def ws_tab(id, window_id, space=0, active=False, accessed=0):
    return {"id": id, "windowId": window_id, "active": active, "lastAccessed": accessed,
            "vivExtData": json.dumps({"workspaceId": space} if space else {})}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class MoveToSpace(unittest.TestCase):
    """Move to <Space> in a tab's menu: Vivaldi's own move, found by source marker; the window stays on the space it shows."""

    FAKE_MOVER = """
      const calls = [];
      const modules = {
        1: function () { return "nothing"; },
        2: function () { return 'async function Pe(e,t,n=!1){}moveToWorkspace:Pe,debug:"PageActions.moveToWorkspace"'; },
      };
      const exportsOf = { 2: { ZP: { moveToIndex() {}, moveToWorkspace: (pages, space) => { calls.push([pages, space]); } } } };
      const require = (id) => { if (!(id in exportsOf)) throw new Error("not loaded: " + id); return exportsOf[id]; };
      require.m = modules;
      const chunks = { push: ([ids, extra, run]) => run(require) };
    """

    def test_find_mover_finds_vivaldis_move(self):
        out = js("(() => {" + self.FAKE_MOVER + "workspaces.findMover(chunks)({ id: 5, windowId: 7 }, 42); return calls; })()")
        self.assertEqual(out, [[{"id": 5, "windowId": 7}, 42]])

    def test_find_mover_returns_null_without_the_marker(self):
        self.assertIsNone(js("workspaces.findMover(undefined)"))
        fake = """
          const require = () => ({ ZP: { moveToWorkspace() {} } });
          require.m = { 1: function () { return "moveToWorkspace:Pe"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertIsNone(js("(() => {" + fake + "return workspaces.findMover(chunks); })()"))

    ITEMS = [{"id": 0, "name": "Home", "emoji": ""}, {"id": 5, "name": "Work", "emoji": ""}, {"id": 9, "name": "Play", "emoji": ""}]

    def test_move_targets_list_every_other_space_default_included_in_tile_order(self):
        out = js("workspaces.moveTargets(items, 5)", items=self.ITEMS)
        self.assertEqual(out, [{"id": 0, "name": "Home"}, {"id": 9, "name": "Play"}])

    def test_the_space_on_screen_is_not_a_target(self):
        for shown in (0, 5, 9):
            ids = [t["id"] for t in js("workspaces.moveTargets(items, shown)", items=self.ITEMS, shown=shown)]
            self.assertNotIn(shown, ids)
            self.assertEqual(len(ids), 2)

    def test_moving_to_default_passes_what_vivaldi_uses_for_default(self):
        out = js("(() => {" + self.FAKE_MOVER + "const move = workspaces.findMover(chunks); move({ id: 5, windowId: 7 }, 0); move({ id: 5, windowId: 7 }, undefined); return calls.map((c) => c[1]); })()")
        self.assertEqual(out, [0, 0], "Vivaldi's own move passes workspaceId: t || 0")

    # native.moveToSpace (08-space-native.js). The fake record: window 7 shows space 42; any other window shows default.
    def moved(self, tabs, ids, space):
        return native_js(f"fakeTabs.push(...{json.dumps(tabs)}); installBg(); await native.moveToSpace({json.dumps(ids)}, {space}); return calls")

    def test_an_inactive_tab_moves_and_nothing_else_is_touched(self):
        tabs = [ws_tab(1, 7, 42, active=True), ws_tab(2, 7, 42)]
        self.assertEqual(self.moved(tabs, [2], 50), [["move", {"id": 2, "windowId": 7}, 50]])

    def test_the_active_tab_hands_the_screen_to_the_spaces_most_recent_other_tab_first(self):
        tabs = [ws_tab(1, 7, 42, active=True, accessed=50), ws_tab(2, 7, 42, accessed=10), ws_tab(3, 7, 42, accessed=40), ws_tab(4, 7, 50, accessed=99)]
        self.assertEqual(self.moved(tabs, [1], 50), [["update", 3, {"active": True}], ["move", {"id": 1, "windowId": 7}, 50]],
                         "tab 4 is more recent but belongs to another space: activating it would switch the window")

    def test_a_lone_active_tab_gets_a_blank_tab_in_its_place_first(self):
        tabs = [ws_tab(1, 7, 42, active=True), ws_tab(4, 7, 50)]
        self.assertEqual(self.moved(tabs, [1], 50), [["create", {"windowId": 7, "active": True}], ["move", {"id": 1, "windowId": 7}, 50]])

    def test_a_space_shown_in_another_window_is_moved_into_that_window(self):
        # Vivaldi's move fails ("ambiguous windowId") when asked to put a tab into a space shown elsewhere, from the tab's own window
        tabs = [ws_tab(1, 8, 0, active=True), ws_tab(2, 8, 0)]
        self.assertEqual(self.moved(tabs, [2], 42), [["move", {"id": 2, "windowId": 7}, 42]])

    def failed(self, tabs, ids, space):
        return native_js(f"""fakeTabs.push(...{json.dumps(tabs)}); installBg(); globalThis.moveFails = true;
          try {{ await native.moveToSpace({json.dumps(ids)}, {space}); return ['no error', calls]; }} catch (e) {{ return [e.message, calls]; }}""")

    def test_a_move_that_reports_success_but_changes_nothing_throws_and_gives_the_screen_back(self):
        tabs = [ws_tab(1, 7, 42, active=True, accessed=50), ws_tab(3, 7, 42, accessed=40)]
        message, calls = self.failed(tabs, [1], 50)
        self.assertIn("did not move", message)
        self.assertEqual(calls, [["update", 3, {"active": True}], ["move", {"id": 1, "windowId": 7}, 50], ["update", 1, {"active": True}]],
                         "the original tab is active again")

    def test_a_failed_move_closes_the_blank_tab_it_made(self):
        message, calls = self.failed([ws_tab(1, 7, 42, active=True)], [1], 50)
        self.assertIn("did not move", message)
        self.assertEqual(calls, [["create", {"windowId": 7, "active": True}], ["move", {"id": 1, "windowId": 7}, 50],
                                 ["update", 1, {"active": True}], ["remove", 900]])

    def test_a_failed_move_of_an_inactive_tab_has_nothing_to_undo(self):
        message, calls = self.failed([ws_tab(1, 7, 42, active=True), ws_tab(2, 7, 42)], [2], 50)
        self.assertIn("did not move", message)
        self.assertEqual(calls, [["move", {"id": 2, "windowId": 7}, 50]])

    def test_a_space_parked_in_this_window_is_moved_within_it(self):
        tabs = [ws_tab(1, 7, 42, active=True), ws_tab(2, 7, 42), ws_tab(5, 7, 50)]
        self.assertEqual(self.moved(tabs, [2], 50), [["move", {"id": 2, "windowId": 7}, 50]])

    def test_a_space_parked_in_another_window_is_refused_before_anything_moves(self):
        # measured: asked from the tab's window the move fails; asked with the holding window it lands in that window's SHOWN space, the wrong one
        tabs = [ws_tab(1, 7, 42, active=True), ws_tab(2, 7, 42), ws_tab(5, 8, 50), ws_tab(6, 8, 0, active=True)]
        message, calls = self.failed(tabs, [1], 50)
        self.assertIn("another window", message)
        self.assertEqual(calls, [], "no keeper activated, nothing moved")

    def test_without_vivaldis_move_it_rejects_instead_of_throwing(self):
        out = native_js("try { await native.moveToSpace([2], 50); return 'no error'; } catch (e) { return e.message; }")
        self.assertIn("unavailable", out)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class TearOff(unittest.TestCase):
    """A tab row dragged out past the window's edge opens in a new window (Byron, 2026-11-08)."""
    BOUNDS = {"left": 100, "top": 50, "width": 800, "height": 600}
    SCREEN = {"width": 1920, "height": 1080}

    def decide(self, **over):
        args = {"point": {"x": 1000, "y": 300}, "bounds": self.BOUNDS, "screen": self.SCREEN, "tabCount": 3,
                "kind": "tab", "dropEffect": "none"}
        args.update(over)
        return js("workspaces.tearOff(args)", args=args)

    def test_a_drop_beyond_the_window_tears_off_near_the_drop_point(self):
        self.assertEqual(self.decide(), {"left": 960, "top": 280})

    def test_a_drop_inside_the_window_stays(self):
        self.assertIsNone(self.decide(point={"x": 500, "y": 300}))

    def test_the_window_edge_counts_as_inside(self):
        self.assertIsNone(self.decide(point={"x": 900, "y": 300}))
        self.assertIsNone(self.decide(point={"x": 100, "y": 50}))
        self.assertIsNotNone(self.decide(point={"x": 901, "y": 300}))
        self.assertIsNotNone(self.decide(point={"x": 99, "y": 300}))

    def test_above_and_below_the_window_tear_off_too(self):
        self.assertIsNotNone(self.decide(point={"x": 500, "y": 20}))
        self.assertIsNotNone(self.decide(point={"x": 500, "y": 700}))

    def test_the_only_tab_stays(self):
        self.assertIsNone(self.decide(tabCount=1))

    def test_pins_favorites_and_folders_stay(self):
        self.assertIsNone(self.decide(kind="bm"))

    def test_a_drop_a_target_accepted_stays(self):
        self.assertIsNone(self.decide(dropEffect="move"))
        self.assertIsNone(self.decide(dropEffect="copy"))

    def test_the_position_is_kept_on_screen(self):
        self.assertEqual(self.decide(point={"x": 1900, "y": 1070}), {"left": 1920 - 120, "top": 1080 - 80})
        self.assertEqual(self.decide(point={"x": -300, "y": -20}), {"left": 0, "top": 0})

    def test_a_display_that_does_not_start_at_zero_keeps_its_own_origin(self):
        screen = {"left": -1920, "top": 0, "width": 1920, "height": 1080}
        self.assertEqual(self.decide(point={"x": -1000, "y": 300}, screen=screen), {"left": -1040, "top": 280})
        self.assertEqual(self.decide(point={"x": -5000, "y": 300}, screen=screen), {"left": -1920, "top": 280})

    def test_without_a_known_display_the_point_is_used_as_is(self):
        self.assertEqual(self.decide(screen=None, point={"x": -300, "y": 1500}), {"left": -340, "top": 1480})

    def test_a_drag_that_reports_no_position_stays(self):
        self.assertIsNone(self.decide(point={"x": 0, "y": 0}))

    def torn(self, ext):
        tab = {"id": 1, "vivExtData": json.dumps(ext) if ext is not None else None}
        return json.loads(js("workspaces.tornData(tab)", tab=tab))

    def test_a_torn_tab_is_written_into_the_default_space(self):
        self.assertEqual(self.torn({"workspaceId": 5}), {"workspaceId": 0})
        self.assertEqual(self.torn(None), {"workspaceId": 0})

    def test_a_torn_tab_leaves_its_split_view_and_folder(self):
        # chrome.tabs.update merges vivExtData: a key leaves only when written as null (measured)
        out = self.torn({"workspaceId": 5, "tiling": {"id": "t", "index": 1}, "group": "g", "fixedGroupTitle": "F", "vivarcPin": "77"})
        self.assertEqual(out, {"workspaceId": 0, "tiling": None, "group": None, "fixedGroupTitle": None, "vivarcPin": "77"})

    def test_keys_the_tab_never_had_are_not_written(self):
        self.assertNotIn("tiling", self.torn({"workspaceId": 5, "keep": 1}))
        self.assertNotIn("group", self.torn({"keep": 1}))
        self.assertEqual(self.torn({"keep": 1})["keep"], 1)

    def test_unknown_numbers_never_tear_off(self):
        self.assertIsNone(self.decide(point={"x": None, "y": 300}))
        self.assertIsNone(self.decide(bounds=None))
        self.assertIsNone(js("workspaces.tearOff(null)"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class CrossWindowDrop(unittest.TestCase):
    """A tab dragged from another window's sidebar into this one moves here (Byron, 2026-11-08)."""

    def take(self, raw, here=2):
        return js("workspaces.crossDrop({ raw, here })", raw=raw, here=here)

    def payload(self, **over):
        data = {"kind": "tab", "tabId": 41, "windowId": 1}
        data.update(over)
        return json.dumps(data)

    def test_a_tab_from_another_window_is_accepted(self):
        self.assertEqual(self.take(self.payload()), {"tabId": 41, "windowId": 1})

    def test_a_tab_from_this_window_is_left_to_the_in_window_drop(self):
        self.assertIsNone(self.take(self.payload(windowId=2)))

    def test_something_that_is_not_a_tab_is_ignored(self):
        self.assertIsNone(self.take(self.payload(kind="bm")))
        self.assertIsNone(self.take(json.dumps({"tabId": 41, "windowId": 1})))

    def test_a_malformed_payload_is_ignored(self):
        for raw in ["", "not json", "null", "[]", "7", self.payload(tabId="41"), self.payload(tabId=None),
                    self.payload(windowId="1"), self.payload(tabId=1.5), self.payload(windowId=None), None]:
            self.assertIsNone(self.take(raw), raw)

    def test_a_drop_above_a_row_lands_above_it_below_lands_below(self):
        # the sidebar lists the highest index first
        row = {"index": 5}
        self.assertEqual(js("workspaces.acrossIndex(row, 'before')", row=row), 6)
        self.assertEqual(js("workspaces.acrossIndex(row, 'after')", row=row), 5)

    def test_the_middle_of_a_row_counts_as_its_nearer_edge(self):
        self.assertEqual(js("workspaces.acrossZone(0.3)"), "before")
        self.assertEqual(js("workspaces.acrossZone(0.5)"), "after")
        self.assertEqual(js("workspaces.acrossZone(0.9)"), "after")

    def test_the_arrival_is_written_into_the_shown_space_out_of_split_and_folder(self):
        tab = {"id": 1, "vivExtData": json.dumps({"workspaceId": 5, "tiling": {"id": "t"}, "group": "g", "keep": 1})}
        out = json.loads(js("workspaces.tornData(tab, 9)", tab=tab))
        self.assertEqual(out, {"workspaceId": 9, "tiling": None, "group": None, "keep": 1})
        self.assertEqual(json.loads(js("workspaces.tornData(tab)", tab=tab))["workspaceId"], 0)


class NewTabMenu(unittest.TestCase):
    """Task 8k: what the New Tab row's dropdown lists (pure helpers; the menu itself is checked live in the sandbox)."""
    SPACES = [{"id": 10, "name": "Work"}, {"id": 20, "name": "Play"}]

    def groups(self, tabs, here=1, spaces=None):
        return js("workspaces.openTabGroups(tabs, spaces, here, 'Home')", tabs=tabs, spaces=self.SPACES if spaces is None else spaces, here=here)

    @staticmethod
    def tab(id, window, space=0, index=0, **over):
        t = {"id": id, "windowId": window, "index": index, "title": f"t{id}", "url": f"https://e.test/{id}",
             "vivExtData": json.dumps({"workspaceId": space} if space else {})}
        t.update(over)
        return t

    def test_open_tabs_group_by_window_then_space_with_this_window_first(self):
        tabs = [self.tab(1, 2), self.tab(2, 1, 20), self.tab(3, 1, 10), self.tab(4, 1, 0), self.tab(5, 2, 10)]
        out = self.groups(tabs, here=2)
        self.assertEqual([(g["heading"], [t["id"] for t in g["tabs"]]) for g in out], [
            ("This window · Home", [1]), ("This window · Work", [5]),
            ("Window 1 · Home", [4]), ("Window 1 · Work", [3]), ("Window 1 · Play", [2])])

    def test_one_window_needs_no_window_name(self):
        out = self.groups([self.tab(1, 1, 10), self.tab(2, 1, 0)])
        self.assertEqual([g["heading"] for g in out], ["Home", "Work"])

    def test_tabs_in_a_group_follow_the_window_order_and_empty_groups_are_left_out(self):
        tabs = [self.tab(1, 1, 0, index=5), self.tab(2, 1, 0, index=2)]
        out = self.groups(tabs)
        self.assertEqual([t["id"] for t in out[0]["tabs"]], [2, 1])
        self.assertEqual(len(out), 1)
        self.assertEqual(self.groups([]), [])

    def test_a_space_the_list_does_not_know_still_gets_a_heading(self):
        out = self.groups([self.tab(1, 1, 99)])
        self.assertEqual([g["heading"] for g in out], ["Space"])

    def test_mute_all_says_unmute_only_when_every_tab_is_muted(self):
        def mute(*flags):
            return js("workspaces.muteAllLabel(tabs)", tabs=[{"mutedInfo": {"muted": f}} for f in flags])
        self.assertEqual(mute(False, False), "Mute All Tabs")
        self.assertEqual(mute(True, False), "Mute All Tabs")
        self.assertEqual(mute(True, True), "Unmute All Tabs")
        self.assertEqual(js("workspaces.muteAllLabel([{}, {mutedInfo: {muted: true}}])"), "Mute All Tabs")
        self.assertEqual(js("workspaces.muteAllLabel([])"), "Mute All Tabs")

    @staticmethod
    def sessions():
        def win(sid, *titles):
            return {"window": {"sessionId": sid, "tabs": [{"title": t, "url": f"https://e.test/{t}"} for t in titles]}}

        def tab(sid, title):
            return {"tab": {"sessionId": sid, "title": title, "url": f"https://e.test/{sid}", "favIconUrl": "f"}}
        return [tab("a", "A"), win("w1", "First", "Second"), tab("b", ""), win("w2", "Solo"), {"tab": {"title": "no id"}}, tab("c", "C")]

    def test_recently_closed_tabs_are_the_tab_entries_newest_first_and_capped(self):
        out = js("workspaces.closedTabs(s, 2)", s=self.sessions())
        self.assertEqual([(t["sessionId"], t["title"]) for t in out], [("a", "A"), ("b", "https://e.test/b")])
        self.assertEqual(len(js("workspaces.closedTabs(s)", s=self.sessions())), 3)  # the one with no session id is skipped

    def test_recently_closed_windows_say_how_many_tabs_will_come_back_and_name_the_first(self):
        out = js("workspaces.closedWindows(s)", s=self.sessions())
        self.assertEqual([(w["sessionId"], w["label"]) for w in out], [("w1", "2 tabs — First"), ("w2", "1 tab — Solo")])

    def test_a_long_first_title_is_cut_and_an_untitled_tab_falls_back_to_its_address(self):
        long = js("workspaces.closedWindowLabel({tabs: [{title: 'x'.repeat(80)}]})")
        self.assertTrue(long.startswith("1 tab — xxx") and long.endswith("…") and len(long) < 45, long)
        self.assertEqual(js("workspaces.closedWindowLabel({tabs: [{title: '', url: 'https://e.test/p'}, {}]})"), "2 tabs — https://e.test/p")
        self.assertEqual(js("workspaces.closedWindowLabel({tabs: []})"), "0 tabs")

    def test_close_all_says_how_many_close_and_that_folders_stay(self):
        self.assertEqual(js("workspaces.closeAllLabel(1, 0)"), "Close 1 tab")
        self.assertEqual(js("workspaces.closeAllLabel(5, 0)"), "Close 5 tabs")
        self.assertEqual(js("workspaces.closeAllLabel(5, 2)"), "Close 5 tabs (folders stay)")


DAY = 24 * 3600 * 1000


class CleanUp(unittest.TestCase):
    """Task 8n: which tabs Clean Up closes, what Recently Cleaned keeps, when the daily run is due (pure helpers; the menu,
    the closing, Undo and the daily runner are checked live in the sandbox)."""
    NOW = 1800000000000  # a realistic clock (2027): the unknown-age rule treats anything before 2000 as unknown

    @classmethod
    def tab(cls, id, idle_days=8, window=1, space=0, **over):
        t = {"id": id, "windowId": window, "lastAccessed": cls.NOW - idle_days * DAY, "vivExtData": json.dumps({"workspaceId": space} if space else {}),
             "url": f"https://e.test/{id}", "title": f"t{id}"}
        t.update(over)
        return t

    def set(self, tabs, **over):
        args = {"tabs": tabs, "now": self.NOW}
        args.update(over)
        return js("workspaces.cleanupSet(args)", args=args)

    def test_a_tab_idle_more_than_a_week_is_cleaned_and_a_fresh_one_is_not(self):
        self.assertEqual(self.set([self.tab(1, 8), self.tab(2, 6.9), self.tab(3, 30)]), [1, 3])

    def test_exactly_seven_days_is_kept_and_a_millisecond_more_is_cleaned(self):
        self.assertEqual(self.set([self.tab(1, 7)]), [])
        self.assertEqual(self.set([self.tab(1, 7, lastAccessed=self.NOW - 7 * DAY - 1)]), [1])

    def test_idle_time_is_a_parameter(self):
        self.assertEqual(self.set([self.tab(1, 2), self.tab(2, 0.5)], idleMs=DAY), [1])

    def test_a_pinned_tab_is_never_cleaned(self):
        self.assertEqual(self.set([self.tab(1, 40, pinned=True)]), [])

    def test_a_tab_bound_to_a_vivarc_pin_or_favorite_is_never_cleaned(self):
        bound = self.tab(1, 40, vivExtData=json.dumps({"vivarcPin": "b1", "workspaceId": 5}))
        self.assertEqual(self.set([bound, self.tab(2, 40, vivExtData=json.dumps({"vivarcHome": "x"}))]), [2])

    def test_the_tab_on_screen_is_never_cleaned_in_any_window(self):
        self.assertEqual(self.set([self.tab(1, 40, active=True), self.tab(2, 40, window=2, active=True), self.tab(3, 40, window=2)]), [3])

    def test_a_tab_playing_sound_is_never_cleaned(self):
        self.assertEqual(self.set([self.tab(1, 40, audible=True), self.tab(2, 40, audible=False)]), [2])

    def test_a_tab_whose_last_use_is_unknown_is_never_cleaned(self):
        t = self.tab(1)
        del t["lastAccessed"]
        self.assertEqual(self.set([t, self.tab(2, 40, lastAccessed=None)]), [])

    def test_a_last_use_of_zero_or_before_the_year_2000_is_unknown_and_kept(self):
        self.assertEqual(self.set([self.tab(1, lastAccessed=0), self.tab(2, lastAccessed=946684799999), self.tab(3, lastAccessed=-5)]), [])
        self.assertEqual(self.set([self.tab(1, lastAccessed=946684800001)]), [1])

    def test_a_malformed_vivextdata_fails_closed_and_the_tab_is_kept(self):
        self.assertEqual(self.set([self.tab(1, vivExtData="{not json"), self.tab(2, vivExtData="null"), self.tab(3, vivExtData=json.dumps([1]))]), [])

    def test_a_tab_with_no_address_is_kept_because_it_would_close_with_no_entry(self):
        self.assertEqual(self.set([self.tab(1, url=""), self.tab(2, url=None), self.tab(3, url="", pendingUrl="https://e.test/p")]), [3])

    def test_a_private_tab_is_never_cleaned(self):
        self.assertEqual(self.set([self.tab(1, 40, incognito=True), self.tab(2, 40, incognito=False)]), [2])

    @staticmethod
    def tiled(id, tiling, **over):
        return CleanUp.tab(id, 40, vivExtData=json.dumps({"tiling": {"id": tiling, "layout": "row", "type": "tile", "index": id}}), **over)

    def test_a_tab_visible_in_a_split_view_with_the_active_one_counts_as_on_screen(self):
        tabs = [self.tiled(1, "t1", active=True), self.tiled(2, "t1"), self.tiled(3, "t2"), self.tab(4, 40)]
        self.assertEqual(self.set(tabs), [3, 4])

    def test_a_split_view_only_shields_within_its_own_window(self):
        tabs = [self.tiled(1, "t1", active=True), self.tiled(2, "t1", window=2), self.tiled(3, "t1", window=2, active=True)]
        self.assertEqual(self.set(tabs), [])
        self.assertEqual(self.set([self.tiled(1, "t1", active=True, window=1), self.tiled(2, "t1", window=2)]), [2])

    def test_a_tab_in_a_folder_is_cleaned_like_any_other(self):
        self.assertEqual(self.set([self.tab(1, 40, vivExtData=json.dumps({"group": "g1", "workspaceId": 5}))]), [1])

    def test_the_menu_run_is_one_window_and_one_space(self):
        tabs = [self.tab(1, 40, window=1, space=0), self.tab(2, 40, window=1, space=5), self.tab(3, 40, window=2, space=0), self.tab(4, 40, window=2, space=5)]
        self.assertEqual(self.set(tabs, window=1, space=5), [2])
        self.assertEqual(self.set(tabs, window=1, space=0), [1])
        self.assertEqual(self.set(tabs, window=2, space=0), [3])

    def test_the_daily_run_leaves_scope_out_and_takes_every_space_in_every_window(self):
        tabs = [self.tab(1, 40, window=1, space=0), self.tab(2, 40, window=1, space=5), self.tab(3, 40, window=2, space=0),
                self.tab(4, 40, window=2, space=6, active=True), self.tab(5, 40, window=2, space=6)]
        self.assertEqual(self.set(tabs), [1, 2, 3, 5])

    def test_nothing_to_go_on_cleans_nothing(self):
        self.assertEqual(js("workspaces.cleanupSet()"), [])
        self.assertEqual(js("workspaces.cleanupSet({tabs: [], now: 5})"), [])
        self.assertEqual(js("workspaces.cleanupSet({tabs: t, now: NaN})", t=[self.tab(1)]), [])

    @staticmethod
    def entry(url, at, space=0):
        return {"url": url, "title": url, "favIconUrl": "", "space": space, "cleanedAt": at}

    def keep(self, old, added, now=None):
        return js("workspaces.keepCleaned(old, added, now)", old=old, added=added, now=self.NOW if now is None else now)

    def test_what_was_cleaned_is_remembered_by_address_title_icon_space_and_time(self):
        tab = self.tab(1, 8, space=5, favIconUrl="https://e.test/f.png")
        self.assertEqual(js("workspaces.cleanedEntry(tab, 77)", tab=tab), {"url": "https://e.test/1", "title": "t1", "favIconUrl": "https://e.test/f.png", "space": 5, "cleanedAt": 77})
        self.assertEqual(js("workspaces.cleanedEntry(tab, 1)", tab={"id": 2})["url"], "")

    def test_the_list_is_newest_first_with_the_new_entries_ahead_of_equal_times(self):
        out = self.keep([self.entry("old", self.NOW - 2 * DAY), self.entry("older", self.NOW - 3 * DAY)], [self.entry("a", self.NOW), self.entry("b", self.NOW)])
        self.assertEqual([e["url"] for e in out], ["a", "b", "old", "older"])

    def test_entries_older_than_thirty_days_are_dropped_and_exactly_thirty_stays(self):
        out = self.keep([self.entry("edge", self.NOW - 30 * DAY), self.entry("gone", self.NOW - 30 * DAY - 1)], [])
        self.assertEqual([e["url"] for e in out], ["edge"])

    def test_at_most_two_hundred_are_kept_and_the_oldest_go(self):
        # built in JS: 250 entries would overflow the command line
        out = js("""(() => {
          const e = (url, cleanedAt) => ({ url, cleanedAt });
          const old = Array.from({ length: 150 }, (_, i) => e("o" + i, now - 1000 - i));
          const added = Array.from({ length: 100 }, (_, i) => e("n" + i, now - i));
          return workspaces.keepCleaned(old, added, now).map((x) => x.url);
        })()""", now=self.NOW)
        self.assertEqual(len(out), 200)
        self.assertEqual(out[0], "n0")
        self.assertEqual(out[-1], "o99")
        self.assertNotIn("o100", out)

    def test_every_closable_tab_has_a_stored_entry_when_a_run_is_over_the_cap(self):
        # 250 candidates in one run against 150 older entries: the list holds 200, and only tabs whose entry is in it may close
        out = js("""(() => {
          const e = (url, cleanedAt) => ({ url, title: url, favIconUrl: "", space: 0, cleanedAt });
          const old = Array.from({ length: 150 }, (_, i) => e("o" + i, now - 1000 - i));
          const added = Array.from({ length: 250 }, (_, i) => e("n" + i, now));
          const list = workspaces.keepCleaned(old, added, now);
          const ok = workspaces.confirmedEntries(list, added);
          return { len: list.length, closable: ok.filter(Boolean).length, firstOk: ok.indexOf(false), allOldGone: list.every((x) => x.url.startsWith("n")),
                   listed: added.filter((_, i) => ok[i]).every((a) => list.some((x) => x.url === a.url)) };
        })()""", now=self.NOW)
        self.assertEqual(out["len"], 200)
        self.assertEqual(out["closable"], 200)
        self.assertEqual(out["firstOk"], 200)  # the first 200 fit, the last 50 stay open
        self.assertTrue(out["allOldGone"])  # older entries went first
        self.assertTrue(out["listed"])

    def test_confirmation_is_per_entry_and_counts_identical_entries_once_each(self):
        out = js("""(() => {
          const a = { url: "u", title: "t", space: 0, cleanedAt: 5 };
          return [workspaces.confirmedEntries([a], [a, a]), workspaces.confirmedEntries([], [a]), workspaces.confirmedEntries([a, a], [a, a]), workspaces.confirmedEntries(null, [a])];
        })()""")
        self.assertEqual(out, [[True, False], [False], [True, True], [False]])

    def test_the_daily_leader_is_the_lowest_non_private_normal_window(self):
        wins = [{"id": 1, "type": "normal", "incognito": True}, {"id": 2, "type": "normal", "incognito": False}, {"id": 3, "type": "normal"}, {"id": 0, "type": "popup"}]
        self.assertEqual(js("workspaces.cleanupLeader(w)", w=wins), 2)
        self.assertIsNone(js("workspaces.cleanupLeader(w)", w=[wins[0]]))

    def test_a_broken_entry_is_dropped_not_thrown_on(self):
        out = self.keep([None, {"url": "", "cleanedAt": self.NOW}, {"url": "x"}, "junk", self.entry("ok", self.NOW)], None)
        self.assertEqual([e["url"] for e in out], ["ok"])
        self.assertEqual(js("workspaces.keepCleaned(null, null, 5)"), [])

    def due(self, last, now=None):
        return js("workspaces.cleanupDue(last, now)", last=last, now=self.NOW if now is None else now)

    def test_the_daily_run_is_due_when_it_never_ran_or_a_day_has_passed(self):
        self.assertTrue(self.due(None))
        self.assertTrue(self.due(0))
        self.assertTrue(self.due("junk"))
        self.assertTrue(self.due(self.NOW - DAY))
        self.assertTrue(self.due(self.NOW - 3 * DAY))

    def test_the_daily_run_is_not_due_within_the_day(self):
        self.assertFalse(self.due(self.NOW - DAY + 1))
        self.assertFalse(self.due(self.NOW))

    def test_a_last_run_in_the_future_is_due_so_a_wrong_clock_cannot_stop_it_for_good(self):
        self.assertTrue(self.due(self.NOW + 5 * DAY))

    def test_ages_read_in_days(self):
        def ago(ms):
            return js("workspaces.cleanedAgo(0, ms)", ms=ms)
        self.assertEqual(ago(0), "today")
        self.assertEqual(ago(DAY - 1), "today")
        self.assertEqual(ago(DAY), "1 day ago")
        self.assertEqual(ago(5 * DAY + 3), "5 days ago")
        self.assertEqual(js("workspaces.cleanedAgo(10, 5)"), "today")  # a clock that went back

    def home(self, entry_space, **over):
        args = {"entry": {"space": entry_space}, "here": 1, "shown": 5, "spaces": [5, 6], "record": [[6, 2]],
                "tabs": [self.tab(9, 1, window=2, space=6)]}
        args.update(over)
        return js("workspaces.cleanedHome({...a, record: new Map(a.record)})", a=args)

    def test_a_cleaned_tab_goes_back_to_its_space_in_the_window_it_lives_in(self):
        self.assertEqual(self.home(6), {"window": 2, "space": 6})

    def test_a_default_space_tab_comes_back_here(self):
        self.assertEqual(self.home(0), {"window": 1, "space": 0})

    def test_a_space_that_no_longer_exists_means_the_space_on_screen_here(self):
        self.assertEqual(self.home(7), {"window": 1, "space": 5})
        self.assertEqual(self.home(7, shown=0), {"window": 1, "space": 0})

    def test_a_space_with_no_window_comes_back_here_and_an_unreadable_list_trusts_the_entry(self):
        self.assertEqual(self.home(5, record=[], tabs=[]), {"window": 1, "space": 5})
        self.assertEqual(self.home(7, spaces=None, record=[], tabs=[]), {"window": 1, "space": 7})


if __name__ == "__main__":
    unittest.main()
