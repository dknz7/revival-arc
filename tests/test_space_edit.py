"""Task 9c: undelete a space, edit a space (upstream KASOGIT/vivarc#126), and staying in an empty space.

The pure parts of src/js/08-space-edit.js (what a deleted space's entry holds, its caps, how it comes back, the order
maths, the rename check) and of src/js/18-empty-space.js (what closing the tab on screen does), then the parts that talk
to Vivaldi, against fakes: the store-before-delete with its read-back, undelete through Vivaldi's own manager, the heal
leaving a held space alone until its entry expires.
"""
import json
import os
import shutil
import subprocess
import unittest

from jsrun import JS_DIR

DAY = 24 * 3600 * 1000

# Loads 07-workspaces.js, 08-space-edit.js and 18-empty-space.js with a fake window (18's runtime start waits on
# __vm.ready, which never resolves here), then evaluates `expr` (async; `data` entries are variables in it).
PURE = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
globalThis.window = { __vm: { ready: new Promise(() => {}) } };
for (const f of ["07-workspaces.js", "08-space-edit.js", "18-empty-space.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
const workspaces = window.__vm.workspaces, edit = window.__vm.spaceEdit, empty = window.__vm.emptySpace;
Object.assign(globalThis, input.data);
eval("(async () => {" + input.expr + "})()").then((v) => process.stdout.write(JSON.stringify(v === undefined ? null : v, (k, x) => (x === undefined ? null : x))),
  (e) => { process.stdout.write(JSON.stringify({ threw: String(e && e.message || e) })); });
"""


def run(expr, **data):
    result = subprocess.run(["node", "-e", PURE, JS_DIR, json.dumps({"expr": expr, "data": data})], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def tab(id, window, space=0, index=0, active=False, url=None, title=None, **ext):
    data = {**({"workspaceId": space} if space else {}), **ext}
    return {"id": id, "windowId": window, "index": index, "active": active, "url": url or f"https://site{id}.test/", "title": title or f"T{id}",
            "vivExtData": json.dumps(data), "lastAccessed": 1000 + id}


X, Y, Z = 101, 102, 103
LIST = [{"id": X, "name": "X", "emoji": "", "icon": "<svg>x</svg>"}, {"id": Y, "name": "Y", "emoji": "🎁", "icon": "<svg>y</svg>", "iconId": 4},
        {"id": Z, "name": "Z", "emoji": "", "icon": "<svg>z</svg>"}]


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Entry(unittest.TestCase):
    """What Vivarc's delete remembers under `deletedSpaces`."""

    TABS = [tab(1, 7, 0, 0), tab(2, 7, Y, 3, title="b"), tab(3, 7, Y, 1, title="a", group="g1", fixedGroupTitle="Folder", vivarcPin="pin9"),
            tab(4, 7, Y, 2, url="chrome://vivaldi-webui/startpage"), tab(5, 7, X, 4), tab(6, 7, Y, 5, tiling={"id": "t1", "layout": "row", "type": "selection", "index": 0})]

    def entry(self, **over):
        args = {"space": LIST[1], "list": LIST, "tabs": self.TABS, "record": [[Y, 7]], "rules": [{"id": "r1", "type": "CONTAINS", "expression": "shop", "workspaceId": Y},
                {"id": "r2", "type": "EQUALS", "expression": "x", "workspaceId": X}], "theme": {"on": True, "hue": 10}, "now": 5000}
        args.update(over)
        return run("return edit.deletedEntry({ ...args, record: args.record ? new Map(args.record) : null });", args=args)

    def test_the_space_its_place_rules_window_and_theme(self):
        e = self.entry()
        self.assertEqual({k: e[k] for k in ["v", "id", "name", "emoji", "icon", "iconId", "position", "after", "before", "window", "shown", "deletedAt"]},
                         {"v": 1, "id": Y, "name": "Y", "emoji": "🎁", "icon": "<svg>y</svg>", "iconId": 4, "position": 1, "after": X, "before": Z, "window": 7, "shown": True, "deletedAt": 5000})
        self.assertEqual(e["rules"], [{"type": "CONTAINS", "expression": "shop"}], "its own rules only, read before Vivaldi's delete removes them")
        self.assertEqual(e["theme"], {"on": True, "hue": 10})

    def test_its_tabs_in_order_with_folder_split_pin_and_mute_and_no_blank_tab(self):
        tabs = self.entry()["tabs"]
        self.assertEqual([t["title"] for t in tabs], ["a", "b", "T6"], "window order; the start page is not remembered")
        self.assertEqual({k: tabs[0][k] for k in ["index", "windowId", "pinned", "muted", "group", "fixedGroupTitle", "vivarcPin", "tiling", "sessionId"]},
                         {"index": 1, "windowId": 7, "pinned": False, "muted": False, "group": "g1", "fixedGroupTitle": "Folder", "vivarcPin": "pin9", "tiling": None, "sessionId": None})
        self.assertEqual(tabs[2]["tiling"]["id"], "t1")

    def test_a_parked_space_and_the_ends_of_the_list(self):
        e = self.entry(record=[])
        self.assertEqual((e["window"], e["shown"]), (7, False), "parked: it lived where its tabs are")
        first = self.entry(space=LIST[0])
        self.assertEqual((first["position"], first["after"], first["before"]), (0, None, Y))
        last = self.entry(space=LIST[2])
        self.assertEqual((last["position"], last["after"], last["before"]), (2, Y, None))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Caps(unittest.TestCase):
    """The last 10 spaces, kept 30 days; the heal skips only what can still come back."""

    def test_newest_first_one_per_space_ten_at_most_thirty_days(self):
        out = run("""
          const e = (id, at) => ({ id, deletedAt: at, tabs: [] });
          const list = [e(1, NOW - 31 * DAY), e(2, NOW - 29 * DAY), e(3, NOW - 1), ...Array.from({ length: 12 }, (_, i) => e(10 + i, NOW - 100 - i))];
          const kept = edit.keepDeleted(list, [e(2, NOW)], NOW);
          return kept.map((x) => [x.id, x.deletedAt === NOW]);
        """, NOW=10 * 365 * DAY, DAY=DAY)
        self.assertEqual(len(out), 10)
        self.assertEqual(out[0], [2, True], "a space deleted again keeps only its newest entry, first")
        self.assertEqual(out[1][0], 3)
        self.assertNotIn(1, [i for i, _ in out], "older than 30 days")
        self.assertEqual([i for i, _ in out][2:], list(range(10, 18)), "the oldest go past the cap")

    def test_malformed_entries_are_dropped(self):
        self.assertEqual(run("return edit.keepDeleted([null, 5, { id: 'x', deletedAt: 1, tabs: [] }, { id: 4, tabs: [] }, { id: 4, deletedAt: 9, tabs: {} }, { id: 6, deletedAt: 9, tabs: [] }], [], 10).map((e) => e.id)"), [6])

    def test_held_is_what_the_heal_skips_and_an_expired_entry_is_not(self):
        out = run("""
          const list = [{ id: 8, deletedAt: NOW - 30 * DAY - 1, tabs: [] }, { id: 9, deletedAt: NOW - 30 * DAY, tabs: [] }];
          const ids = edit.held(list, NOW).map((e) => e.id);
          const tabs = [{ id: 1, windowId: 1, vivExtData: '{"workspaceId":8}' }, { id: 2, windowId: 1, vivExtData: '{"workspaceId":9}' }];
          const read = { pref: [5], store: [5] };
          return [ids, workspaces.healGate({ first: read, second: read, tabs, skip: edit.held(list, NOW) }).ids, edit.held("junk", NOW)];
        """, NOW=10 * 365 * DAY, DAY=DAY)
        self.assertEqual(out, [[9], [8], []], "the expired entry's tabs heal, the held one's do not")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Sessions(unittest.TestCase):
    """Each remembered tab's Recently Closed entry, read right after the delete."""

    def test_by_address_title_first_each_entry_once_and_not_from_before_the_delete(self):
        out = run("""
          const s = (id, url, title, at) => ({ lastModified: at, tab: { sessionId: id, url, title } });
          const sessions = [s("s1", "u1", "A", 100), s("s2", "u1", "B", 100), s("s3", "u2", "C", 100), s("old", "u3", "D", 10), { window: { sessionId: "w" }, lastModified: 100 }];
          const tabs = [{ url: "u1", title: "B" }, { url: "u1", title: "A" }, { url: "u1", title: "A" }, { url: "u2", title: "changed" }, { url: "u3", title: "D" }];
          return edit.matchSessions(tabs, sessions, 100000).map((t) => t.sessionId);
        """)
        self.assertEqual(out, ["s2", "s1", None, "s3", None], "title first, then address; once each; nothing closed before the delete")

    def test_a_listed_id_is_kept_and_a_gone_one_is_matched_again(self):
        out = run("""
          const sessions = [{ lastModified: 100, tab: { sessionId: "n1", url: "u1", title: "A" } }, { lastModified: 100, tab: { sessionId: "k", url: "u2", title: "B" } }];
          return edit.matchSessions([{ url: "u1", title: "A", sessionId: "gone" }, { url: "u2", title: "B", sessionId: "k" }], sessions, 100000).map((t) => t.sessionId);
        """)
        self.assertEqual(out, ["n1", "k"], "after a restart the entries have new ids: found again by address")

    def test_a_stored_id_that_now_names_another_tab_is_not_used(self):
        out = run("""
          const sessions = [{ lastModified: 100, tab: { sessionId: "k", url: "other", title: "X" } }, { lastModified: 100, tab: { sessionId: "n", url: "u2", title: "B" } }];
          return edit.matchSessions([{ url: "u2", title: "B", sessionId: "k" }], sessions, 100000).map((t) => t.sessionId);
        """)
        self.assertEqual(out, ["n"], "ids start afresh each run: an id is trusted only with its address")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Restore(unittest.TestCase):
    """How an entry comes back: its place in the list and its tabs' plan."""

    def order(self, ids, **entry):
        return run("return edit.orderAfter(ids, { id: 102, position: 1, after: null, before: null, ...entry });", ids=ids, entry=entry)

    def test_before_its_old_neighbour_else_after_the_other_else_its_old_place(self):
        self.assertEqual(run("return edit.orderAfter([101, 103, 102], { id: 102, position: 1, after: 101, before: 103 })"), [101, 102, 103])
        self.assertEqual(run("return edit.orderAfter([101, 104, 102], { id: 102, position: 1, after: 101, before: 103 })"), [101, 102, 104], "its next neighbour is gone")
        self.assertEqual(run("return edit.orderAfter([104, 105, 102], { id: 102, position: 1, after: 101, before: 103 })"), [104, 102, 105], "both gone: its old place")
        self.assertEqual(run("return edit.orderAfter([102, 104], { id: 102, position: 7, after: 1, before: 3 })"), [104, 102], "clamped to the end")
        self.assertIsNone(run("return edit.orderAfter([101, 102, 103], { id: 102, position: 1, after: 101, before: 103 })"))

    def test_the_old_window_while_open_else_the_asking_one(self):
        entry = {"id": Y, "window": 7, "deletedAt": 100000, "tabs": [{"url": "u2", "title": "B", "index": 4, "windowId": 7, "sessionId": "s2"},
                 {"url": "u1", "title": "A", "index": 2, "windowId": 7, "sessionId": None}, {"url": "u3", "title": "C", "index": 3, "windowId": 7, "sessionId": "gone"}]}
        sessions = [{"lastModified": 100, "tab": {"sessionId": "s2", "url": "u2", "title": "B"}}, {"lastModified": 100, "tab": {"sessionId": "s9", "url": "u1", "title": "A"}}]
        plan = run("return edit.restorePlan({ entry, windows: [7, 8], here: 8, sessions });", entry=entry, sessions=sessions)
        self.assertEqual(plan["window"], 7)
        self.assertEqual([(t["url"], t["how"], t["sessionId"]) for t in plan["tabs"]], [("u1", "session", "s9"), ("u3", "create", None), ("u2", "session", "s2")],
                         "in their old order; a listed entry restores, else the address opens")
        self.assertEqual(run("return edit.restorePlan({ entry, windows: [8], here: 8, sessions: [] }).window;", entry=entry), 8, "the old window is gone")

    def test_tabs_already_back_are_used_not_opened_again_and_a_new_run_ignores_the_old_window(self):
        entry = {"id": Y, "window": 7, "deletedAt": 100000, "tabs": [{"url": "u1", "title": "A", "index": 1, "windowId": 7}, {"url": "u2", "title": "B", "index": 2, "windowId": 7}]}
        sessions = [{"lastModified": 100, "tab": {"sessionId": "s2", "url": "u2", "title": "B"}}, {"lastModified": 100, "tab": {"sessionId": "s1", "url": "u1", "title": "A"}}]
        plan = run("return edit.restorePlan({ entry, windows: [7, 8], here: 8, sessions, live: [{ id: 55, url: 'u2' }], sameRun: false });", entry=entry, sessions=sessions)
        self.assertEqual(plan["window"], 8, "window ids start afresh after a restart: the asking window")
        self.assertEqual([(t["url"], t["how"], t.get("tab"), t["sessionId"]) for t in plan["tabs"]], [("u1", "session", None, "s1"), ("u2", "live", 55, None)])

    def test_the_note_counts_its_tabs(self):
        self.assertEqual(run("return edit.deletedNote({ deletedAt: NOW - 2 * DAY, tabs: [1, 2, 3, 4] }, NOW)", NOW=40 * DAY, DAY=DAY), "4 tabs · 2 days ago")
        self.assertEqual(run("return edit.deletedNote({ deletedAt: NOW, tabs: [1] }, NOW)", NOW=40 * DAY), "1 tab · today")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Edit(unittest.TestCase):
    """Order maths, names, and the folder-first rename's check."""

    def test_move_left_and_right_stop_at_the_ends(self):
        self.assertEqual(run("return [edit.moved([1, 2, 3], 2, -1), edit.moved([1, 2, 3], 2, 1), edit.moved([1, 2, 3], 1, -1), edit.moved([1, 2, 3], 3, 1), edit.moved([1, 2], 9, 1)]"),
                         [[2, 1, 3], [1, 3, 2], None, None, None])

    def test_a_new_space_gets_a_free_name(self):
        self.assertEqual(run("return [edit.newSpaceName([]), edit.newSpaceName([{ name: 'new space' }]), edit.newSpaceName([{ name: 'New Space' }, { name: 'New Space 2' }])]"),
                         ["New Space", "New Space 2", "New Space 3"])
        self.assertEqual(run("return edit.newSpaceName([], 'New Space', ['Vivarc', 'New Space'])"), "New Space 2", "a leftover Pinned folder's name is taken too")

    FOLDERS = [{"id": "f0", "title": "Vivarc"}, {"id": "fx", "title": "Arc - X"}, {"id": "fy", "title": "Y"}, {"id": "stray", "title": "Old"}]

    def check(self, name, id=X):
        return run("return edit.renameCheck({ name, id, list, folders });", name=name, id=id, list=LIST, folders=self.FOLDERS)

    def test_rename_refuses_a_name_that_would_take_someone_elses_pins(self):
        self.assertEqual(self.check("  Work "), {"name": "Work"})
        self.assertEqual(self.check("X"), {"same": True})
        self.assertEqual(self.check(""), {"why": "A space needs a name"})
        self.assertEqual(self.check("y")["why"], "There is already a space called “y”")
        self.assertEqual(self.check("vivarc")["why"], "“vivarc” is the default space's Pinned folder")
        self.assertIn("A Pinned folder called “Old” is already in your bookmarks", self.check("Old")["why"], "a folder no space claims")
        self.assertEqual(self.check("x "), {"name": "x"}, "its own folder's name, another case: fine")

    def test_the_folder_keeps_its_arc_prefix(self):
        self.assertEqual(run("return [edit.folderTitle('Arc - X', 'Work'), edit.folderTitle('X', 'Work')]"), ["Arc - Work", "Work"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class EmptySpace(unittest.TestCase):
    """18-empty-space.js: the tab on screen closed; does the window stay in its space, empty, with the bar?"""

    def decide(self, closed, now, tabs, known=(X, Y), busy=False):
        return run("return empty.decide({ closed, now, known, tabs, busy });", closed=closed, now=now, tabs=tabs, known=list(known) if known is not None else None, busy=busy)

    def test_the_last_page_of_a_space_closed_the_space_stays(self):
        self.assertEqual(self.decide({"space": X, "page": True}, X, [tab(1, 7, 0, active=True)]), {"kind": "create"}, "a new tab, filed by Vivaldi in the recorded space")
        self.assertEqual(self.decide({"space": X, "page": True}, 0, [tab(1, 7, 0, active=True)]), {"kind": "switch", "space": X}, "the record moved: Vivaldi's switch makes the start page")

    def test_only_a_blank_tab_left_it_is_shown_with_the_bar(self):
        tabs = [tab(1, 7, 0, active=True), tab(2, 7, X, url="chrome://vivaldi-webui/startpage")]
        self.assertEqual(self.decide({"space": X, "page": True}, X, tabs), {"kind": "bar", "tab": 2, "switch": False, "space": X})
        self.assertEqual(self.decide({"space": X, "page": True}, 0, tabs)["switch"], True)

    def test_the_default_space_too(self):
        self.assertEqual(self.decide({"space": 0, "page": True}, 0, [tab(1, 7, X, active=True)]), {"kind": "create"})

    def test_nothing_when_a_page_is_left_a_blank_tab_closed_a_deleted_space_or_a_gesture(self):
        page_left = [tab(1, 7, X, active=True), tab(2, 7, X)]
        self.assertEqual(self.decide({"space": X, "page": True}, X, page_left)["kind"], "none", "repair 2 shows the space's page")
        self.assertEqual(self.decide({"space": X, "page": False}, X, [])["kind"], "none", "the bar's own blank tab closing (Escape)")
        self.assertEqual(self.decide({"space": Z, "page": True}, Z, [])["kind"], "none", "a space no longer in the list: rule 1")
        self.assertEqual(self.decide({"space": X, "page": True}, X, [], known=None)["kind"], "none", "the list unreadable")
        self.assertEqual(self.decide({"space": X, "page": True}, None, [])["kind"], "none", "the record unreadable")
        self.assertEqual(self.decide({"space": X, "page": True}, X, [], busy=True)["kind"], "none", "a delete or a move under way")


# The parts that talk to Vivaldi, against fakes: chrome.*, vivaldi.prefs, Vivaldi's manager and route manager in the
# webpack chunks, Vivarc's store and native.
RUNTIME = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const calls = [];
const realTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => realTimeout(fn, Math.min(ms || 0, 5));
globalThis.console = { log() {}, warn: (...a) => calls.push(["warn", a.map(String).join(" ")]), error() {} };
const S = input.state;
let nextTab = 500;
const bg = { __vivarcRun: "run1" };
const kv = new Map(Object.entries(S.store || {}));
const prefs = { "vivaldi.workspaces.list": S.list, "vivaldi.workspaces.link_routes": S.rules || [] };
const mgr = {
  addWorkspaceWithId: (id, name, icon, emoji) => { calls.push(["add", id, name, icon, emoji ?? null]); prefs["vivaldi.workspaces.list"] = [...prefs["vivaldi.workspaces.list"], { id, name, icon, emoji }]; return id; },
  addWorkspace: async (name, icon, emoji, pages, background) => { calls.push(["create", name, icon, background]); const id = 999; prefs["vivaldi.workspaces.list"] = [...prefs["vivaldi.workspaces.list"], { id, name, icon }]; return id; },
  setName: (id, name) => { calls.push(["setName", id, name]); if (S.nameIgnored) return; prefs["vivaldi.workspaces.list"] = prefs["vivaldi.workspaces.list"].map((w) => (w.id === id ? { ...w, name } : w)); },
  setIcon: (id, i) => calls.push(["setIcon", id, i]), setEmoji: (id, e) => calls.push(["setEmoji", id, e]),
  setOrder: (ids) => { calls.push(["setOrder", ids]); const all = prefs["vivaldi.workspaces.list"]; prefs["vivaldi.workspaces.list"] = ids.map((x) => all.find((w) => w.id === x)); },
};
const routes = { addLinkRoutingRule: async (type, expression, id) => calls.push(["rule", type, expression, id]) };
const icons = ["<svg>0</svg>", "<svg>1</svg>", "<svg>default</svg>"];
const wreq = (id) => ({ 1: { Z: mgr }, 2: { Z: routes }, 3: { S: icons, Z: {} } })[id];
wreq.m = { 1: function () { return "addWorkspaceWithId(e,t,n,i){"; }, 2: function () { return "async addLinkRoutingRule(e,t,n){"; }, 3: function () { return "getRandomIcon(){return a[0]}"; } };
if (S.noManager) delete wreq.m[1];
bg.webpackChunkgapp_browser_react = { push: ([a, b, run]) => run(wreq), lastIndexOf: () => -1 };
const tabs = S.tabs || [];
globalThis.chrome = {
  extension: { getBackgroundPage: () => bg },
  windows: { getAll: async () => (S.windows || [7]).map((id) => ({ id, type: "normal" })) },
  bookmarks: { update: async (id, p) => { calls.push(["folder", id, p.title]); } },
  sessions: {
    getRecentlyClosed: async () => S.sessions || [],
    restore: async (sid) => { calls.push(["restore", sid]); const s = (S.sessions || []).find((x) => x.tab?.sessionId === sid); const t = { id: nextTab++, windowId: S.restoreInto ?? 7, index: tabs.length, url: s.tab.url, vivExtData: JSON.stringify({ workspaceId: S.restoredSpace ?? 0 }) }; tabs.push(t); return { tab: t }; },
  },
  tabs: {
    query: async ({ windowId } = {}) => tabs.filter((t) => windowId == null || t.windowId === windowId),
    get: async (id) => tabs.find((t) => t.id === id),
    create: async (p) => { calls.push(["tabs.create", p.url, p.windowId, !!p.pinned]); const t = { id: nextTab++, windowId: p.windowId, index: tabs.length, url: p.url, pinned: !!p.pinned, vivExtData: "{}" }; tabs.push(t); return t; },
    update: async (id, p) => calls.push(["tabs.update", id, p]),
  },
};
globalThis.vivaldi = { prefs: { get: async (path) => ({ value: prefs[path] }) },
  tabsPrivate: { move: async (a) => { calls.push(["tabsPrivate.move", a.tabIds, a.target, a.tweaks]); return a.tweaks.includes("create-new-group") ? { group: "new-g", success: true } : { success: true }; },
    setGroupProperties: async (a) => calls.push(["groupTitle", a.groupExtId, a.groupTitle]) } };
globalThis.window = { __vm: {
  ready: new Promise(() => {}),
  store: {
    get: async (k, d) => (kv.has(k) ? kv.get(k) : d),
    read: async (k) => { if (S.readFails) throw new Error("read failed"); return kv.get(k); },
    set: async (k, v) => { calls.push(["store.set", k]); if (!S.writeIsLost) kv.set(k, JSON.parse(JSON.stringify(v))); },
  },
  setExtData: async (t, patch) => calls.push(["ext", t.id, patch]),
  spaceRepair: { gesture: () => { calls.push(["busy"]); return () => calls.push(["unbusy"]); } },
  native: {
    record: () => ({ all: () => new Map(S.record || []) }),
    setSpace: async (id, space, o) => { calls.push(["setSpace", id, space, o.windowId, o.index ?? null]); const t = tabs.find((x) => x.id === id); if (t) { t.windowId = o.windowId; t.vivExtData = JSON.stringify(space ? { workspaceId: space } : {}); } },
    switchTo: async (w, s) => calls.push(["switch", w, s]),
    focus: async (w) => calls.push(["focus", w]),
    movesByTab: async () => true,
  },
} };
for (const f of ["07-workspaces.js", "08-space-edit.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
const edit = window.__vm.spaceEdit;
eval("(async () => {" + input.expr + "})()").then((v) => process.stdout.write(JSON.stringify({ out: v ?? null, calls, store: Object.fromEntries(kv) })),
  (e) => process.stdout.write(JSON.stringify({ threw: String(e && e.message || e), calls, store: Object.fromEntries(kv) })));
"""


def runtime(expr, **state):
    result = subprocess.run(["node", "-e", RUNTIME, JS_DIR, json.dumps({"expr": expr, "state": state})], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class DeleteAndUndelete(unittest.TestCase):
    TABS = [tab(1, 7, 0, 0), tab(2, 7, Y, 1, title="A"), tab(3, 7, Y, 2, title="B", group="g", vivarcPin="p1"), tab(4, 7, Y, 3, title="C")]

    def test_the_entry_is_stored_and_read_back_before_the_delete(self):
        r = runtime("return edit.remember(102);", list=LIST, tabs=self.TABS, record=[[Y, 7]], rules=[{"id": "r", "type": "CONTAINS", "expression": "q", "workspaceId": Y}],
                    store={"theme:space:102": {"on": True}})
        entry = r["out"]
        self.assertEqual([t["title"] for t in entry["tabs"]], ["A", "B", "C"])
        self.assertEqual(r["store"]["deletedSpaces"][0]["id"], Y)
        self.assertEqual(entry["rules"], [{"type": "CONTAINS", "expression": "q"}])
        self.assertEqual(entry["theme"], {"on": True})

    def test_a_store_that_does_not_keep_it_refuses(self):
        self.assertEqual(runtime("return edit.remember(102);", list=LIST, tabs=self.TABS, writeIsLost=True)["threw"], "the entry did not reach the store")
        self.assertEqual(runtime("return edit.remember(102);", list=LIST, tabs=self.TABS, readFails=True)["threw"], "read failed", "a failed read never writes over the list")
        self.assertIn("not in Vivaldi's list", runtime("return edit.remember(555);", list=LIST, tabs=self.TABS)["threw"])

    def test_closed_tabs_get_their_recently_closed_ids(self):
        sessions = [{"lastModified": 10**10, "tab": {"sessionId": f"s{n}", "url": f"https://site{n}.test/", "title": t}} for n, t in [(2, "A"), (3, "B"), (4, "C")]]
        r = runtime("const e = await edit.remember(102); return (await edit.noteClosed(e)).tabs.map((t) => t.sessionId);", list=LIST, tabs=self.TABS, sessions=sessions)
        self.assertEqual(r["out"], ["s2", "s3", "s4"])
        self.assertEqual([t["sessionId"] for t in r["store"]["deletedSpaces"][0]["tabs"]], ["s2", "s3", "s4"], "stored")

    ENTRY = {"v": 1, "run": "run1", "id": Y, "name": "Y", "emoji": "", "icon": "<svg>y</svg>", "iconId": 1, "position": 1, "after": X, "before": Z,
             "rules": [{"type": "CONTAINS", "expression": "shop"}], "window": 7, "shown": True, "deletedAt": 10**13, "theme": {"on": True, "hue": 3},
             "tabs": [{"url": "u1", "title": "A", "index": 1, "windowId": 7, "pinned": False, "muted": False, "group": None, "fixedGroupTitle": None, "tiling": None, "vivarcPin": None, "sessionId": "s1"},
                      {"url": "u2", "title": "B", "index": 2, "windowId": 7, "pinned": False, "muted": True, "group": "g", "fixedGroupTitle": "F", "tiling": None, "vivarcPin": "p", "sessionId": "gone"}]}

    def undelete(self, entry=None, **over):
        state = {"list": [LIST[0], LIST[2]], "tabs": [tab(1, 7, 0, 0), tab(9, 8, 0, 0)], "windows": [7, 8], "restoredSpace": Y,
                 "sessions": [{"lastModified": 10**10, "tab": {"sessionId": "s1", "url": "u1", "title": "A"}}], "store": {"deletedSpaces": [self.ENTRY]}}
        state.update(over)
        return runtime("return edit.undelete(" + json.dumps(entry or self.ENTRY) + ", 8);", **state)

    def test_the_space_comes_back_with_its_id_place_rules_theme_and_tabs(self):
        r = self.undelete()
        c = [x for x in r["calls"] if x[0] not in ("store.set",)]
        self.assertEqual(c[0], ["busy"])
        self.assertEqual(c[1], ["add", Y, "Y", "<svg>y</svg>", None], "Vivaldi's own store, with the OLD id")
        self.assertEqual(c[2], ["setIcon", Y, 1])
        self.assertIn(["setOrder", [X, Y, Z]], c, "back between its old neighbours")
        self.assertIn(["rule", "CONTAINS", "shop", Y], c)
        self.assertEqual(r["store"]["theme:space:102"], {"on": True, "hue": 3})
        self.assertIn(["restore", "s1"], c, "still listed: restored with its history")
        self.assertIn(["tabs.create", "u2", 7, False], c, "no longer listed: opened by address, in its old window")
        made = [x for x in c if x[0] == "setSpace"]
        self.assertEqual(made, [["setSpace", 501, Y, 7, None]], "the new tab put into the space; the restored one came back in it")
        self.assertIn(["ext", 501, {"vivarcPin": "p"}], c)
        self.assertIn(["tabs.update", 501, {"muted": True}], c)
        self.assertIn(["switch", 7, Y], c, "shown")
        self.assertIn(["focus", 7], c, "asked from window 8: its old window comes forward")
        self.assertEqual(c[-1], ["unbusy"])
        self.assertEqual(r["store"]["deletedSpaces"], [], "restoring removes the entry")
        self.assertEqual(r["out"], {"window": 7, "space": Y, "tabs": 2})

    def test_a_tab_already_back_with_the_id_is_not_opened_twice(self):
        r = self.undelete(tabs=[tab(1, 7, 0, 0), tab(9, 8, 0, 0), {"id": 77, "windowId": 7, "index": 5, "url": "u2", "vivExtData": json.dumps({"workspaceId": Y}), "mutedInfo": {"muted": True}}])
        self.assertNotIn("u2", [c[1] for c in r["calls"] if c[0] == "tabs.create"])
        self.assertIn(["ext", 77, {"vivarcPin": "p"}], r["calls"], "what it lacks is written back")
        self.assertEqual(r["out"]["tabs"], 2)

    def test_after_a_restart_the_asking_window(self):
        old = {**self.ENTRY, "run": "earlier"}
        r = self.undelete(entry=old, store={"deletedSpaces": [old]}, restoreInto=8)
        self.assertIn(["switch", 8, Y], r["calls"])

    def test_a_folder_is_made_again_with_vivaldis_move_and_named(self):
        entry = {**self.ENTRY, "tabs": [{**self.ENTRY["tabs"][1], "url": "u3", "index": 3}, {**self.ENTRY["tabs"][1], "url": "u4", "index": 4}]}
        r = self.undelete(entry=entry, store={"deletedSpaces": [entry]})
        self.assertIn(["tabsPrivate.move", [500, 501], 500, ["do-not-reparent", "create-new-group"]], r["calls"], "8.3 drops a group written to a tab's data")
        self.assertIn(["groupTitle", "new-g", "F"], r["calls"])

    def test_into_the_asking_window_when_the_old_one_is_gone(self):
        r = self.undelete(windows=[8], restoreInto=8)
        self.assertIn(["tabs.create", "u2", 8, False], r["calls"])
        self.assertIn(["switch", 8, Y], r["calls"])
        self.assertNotIn(["focus", 8], r["calls"])

    def test_a_restored_tab_vivaldi_put_elsewhere_is_moved_into_the_space(self):
        r = self.undelete(restoredSpace=0, restoreInto=8)
        self.assertIn(["setSpace", 500, Y, 7, None], r["calls"])

    def test_no_manager_no_change_and_the_entry_stays(self):
        r = self.undelete(noManager=True)
        self.assertEqual(r["threw"], "Vivaldi's workspace manager was not found")
        self.assertEqual([x for x in r["calls"] if x[0] != "warn"], [], "nothing touched, not even the busy mark")
        self.assertEqual(len(r["store"]["deletedSpaces"]), 1, "the entry stays")

    def test_a_rename_vivaldi_does_not_take_puts_the_folder_back(self):
        r = runtime("window.__vm.store; const m = await (async () => { try { await edit.rename(101, 'Work', { id: 'fx', title: 'Arc - X' }); } catch (e) { return e.message; } })(); return m;", list=LIST, nameIgnored=True)
        self.assertEqual(r["out"], "Vivaldi did not take the new name")
        self.assertEqual([x for x in r["calls"] if x[0] == "folder"], [["folder", "fx", "Arc - Work"], ["folder", "fx", "Arc - X"]])

    def test_rename_renames_the_folder_first(self):
        r = runtime("await edit.rename(101, 'Work', { id: 'fx', title: 'Arc - X' }); const during = edit.renaming(101); await new Promise((ok) => setTimeout(ok, 50)); return [during, edit.renaming(101)];", list=LIST)
        steps = [x for x in r["calls"] if x[0] in ("folder", "setName")]
        self.assertEqual(steps, [["folder", "fx", "Arc - Work"], ["setName", X, "Work"]])
        self.assertEqual(r["out"], [True, False], "the mark stays a moment after, then goes")

    def test_plus_makes_a_space_in_the_background_with_the_default_icon(self):
        r = runtime("return edit.create('New Space');", list=LIST)
        self.assertEqual(r["out"], 999)
        self.assertIn(["create", "New Space", "<svg>default</svg>", True], r["calls"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class HealAndExpiry(unittest.TestCase):
    """The real heal (11-space-repair.js, through test_space_rules' runner) with 08-space-edit.js loaded: a held entry's
    tabs stay, an expired one's heal, and a store that cannot be read heals nothing."""

    def heal(self, store):
        from test_space_rules import Repairs, RepairRuntime, runtime
        script = ('vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], "08-space-edit.js"), "utf8"));'
                  "const STORE = () => s.spaces;" + store + RepairRuntime.HEAL_STUBS)
        # the stub moves nothing, so each pass plans the same: the distinct calls are what the heal would move
        out = []
        for c in runtime(Repairs.ORPHANS, me=1, script=script)["calls"]:
            if c[0] == "setSpace" and c not in out: out.append(c)
        return out

    def test_held_stays_expired_heals(self):
        now = "Date.now()"
        calls = self.heal("window.__vm.store = { read: async () => [{ id: 9, deletedAt: " + now + " - 31 * 864e5, tabs: [] }, { id: 8, deletedAt: " + now + ", tabs: [] }] };")
        self.assertEqual(calls, [["setSpace", 11, 0, 1], ["setSpace", 12, 0, 1]], "space 9's entry expired: its tabs heal; space 8's is held")

    def test_an_unreadable_store_heals_nothing(self):
        self.assertEqual(self.heal("window.__vm.store = { read: async () => { throw new Error('no'); } };"), [])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Bundled(unittest.TestCase):
    def test_new_files_are_in_the_bundle_order(self):
        names = sorted(os.listdir(JS_DIR))
        self.assertLess(names.index("07-workspaces.js"), names.index("08-space-edit.js"))
        self.assertLess(names.index("08-space-edit.js"), names.index("11-space-repair.js"), "the heal asks spaceEdit.held at run time")
        self.assertLess(names.index("17-peek.js") if "17-peek.js" in names else 0, names.index("18-empty-space.js"))


if __name__ == "__main__":
    unittest.main()
