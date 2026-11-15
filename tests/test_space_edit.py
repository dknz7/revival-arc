"""Task 9c: undelete a space, edit a space (upstream KASOGIT/vivarc#126), and staying in an empty space.

The pure parts of src/js/08-space-edit.js (what a deleted space's entry holds, its caps, how it comes back, the order
maths, the rename check) and of src/js/18-empty-space.js (what closing the tab on screen does), then the parts that talk
to Vivaldi, against fakes: the store-before-delete with its read-back, undelete through Vivaldi's own manager, and (heal
policy B) undelete taking back the tabs the heal tagged healedFrom.
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
const madeWindows = new Set();
globalThis.chrome = {
  extension: { getBackgroundPage: () => bg, inIncognitoContext: !!S.incognito },
  // windows come and go: S.windows at the start; a restore with S.restoreMakesWindow makes one (its tab and a blank tab);
  // S.userWindowAt: a window the user opens after that many tabs.create calls
  windows: { getAll: async ({ populate } = {}) => { const ids = [...new Set([...(S.windows || [7]), ...madeWindows])];
    return ids.map((id) => ({ id, type: "normal", tabs: populate ? tabs.filter((t) => t.windowId === id) : undefined })); },
    remove: async (id) => { calls.push(["windows.remove", id]); } },
  bookmarks: { update: async (id, p) => { calls.push(["folder", id, p.title]); if (S.folderFails && calls.filter((c) => c[0] === "folder").length > 1) throw new Error("no"); } },
  sessions: {
    getRecentlyClosed: async () => S.sessions || [],
    restore: async (sid) => { calls.push(["restore", sid]); const s = (S.sessions || []).find((x) => x.tab?.sessionId === sid);
      if (S.restoreFails) throw new Error("restore failed");
      // S.userWindowDuringRestore: the user opens a blank window while the restore runs (between its two window reads)
      if (S.userWindowDuringRestore) { madeWindows.add(61); tabs.push({ id: 62, windowId: 61, index: 0, url: "chrome://vivaldi-webui/startpage", vivExtData: "{}" }); }
      let win = S.restoreInto ?? 7;
      if (S.restoreMakesWindow) { win = 50; madeWindows.add(50); tabs.push({ id: 49, windowId: 50, index: 0, url: "chrome://vivaldi-webui/startpage", vivExtData: "{}" }); }
      const t = { id: nextTab++, windowId: win, index: tabs.length, url: s.tab.url, pinned: false, vivExtData: JSON.stringify({ workspaceId: S.restoredSpace ?? 0 }) }; tabs.push(t); return { tab: t }; },
  },
  tabs: {
    query: async ({ windowId } = {}) => tabs.filter((t) => windowId == null || t.windowId === windowId),
    get: async (id) => tabs.find((t) => t.id === id),
    create: async (p) => { calls.push(["tabs.create", p.url, p.windowId, !!p.pinned]);
      if ((S.createFails || []).includes(p.url)) throw new Error("create failed");
      if (S.userWindowAt && calls.filter((c) => c[0] === "tabs.create").length === S.userWindowAt) { madeWindows.add(60); tabs.push({ id: 59, windowId: 60, index: 0, url: "chrome://vivaldi-webui/startpage", vivExtData: "{}" }); } const t = { id: nextTab++, windowId: p.windowId, index: tabs.length, url: p.url, pinned: !!p.pinned, vivExtData: "{}" }; tabs.push(t); return t; },
    remove: async (id) => { calls.push(["tabs.remove", id]); const i = tabs.findIndex((x) => x.id === id); if (i >= 0) tabs.splice(i, 1); },
    update: async (id, p) => { calls.push(["tabs.update", id, p]); const t = tabs.find((x) => x.id === id); if (t && p.active) { for (const o of tabs) if (o.windowId === t.windowId) o.active = o.id === id; } },
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
    record: () => ({ all: () => new Map(S.record || []), activeIn: (w) => [...(S.record || [])].find(([, x]) => x === w)?.[0] ?? 0 }),
    // S.placeFails: the addresses whose move into a named space does nothing (the call returns, the tab stays where it is);
    // S.placeThrows: the same, but the call throws
    setSpace: async (id, space, o) => { calls.push(["setSpace", id, space, o.windowId, o.index ?? null]); const t = tabs.find((x) => x.id === id);
      if (t && space && (S.placeThrows || []).includes(t.url)) throw new Error("move refused");
      if (t && space && (S.placeFails || []).includes(t.url)) return;
      if (t) { t.windowId = o.windowId; t.vivExtData = JSON.stringify(space ? { workspaceId: space } : {}); } },
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
        self.assertEqual(r["out"], {"window": 7, "space": Y, "tabs": 2, "failed": 0})

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
class HealPolicyB(unittest.TestCase):
    """Heal policy B (Byron, 2026-11-15): the heal moves a deleted space's tabs to their window's default space at once and
    tags them healedFrom; undelete takes back the tagged tabs that are still in the default space and match a stored tab,
    clears the tag, and leaves every other tab alone. ENTRY: space Y (102) with tabs u1 (listed in Recently Closed) and
    u2; undelete asked from window 8, the old window 7 open."""
    ENTRY = DeleteAndUndelete.ENTRY

    def undelete(self, extra, **over):
        state = {"list": [LIST[0], LIST[2]], "tabs": [tab(1, 7, 0, 0), tab(9, 8, 0, 0)] + extra, "windows": [7, 8], "restoredSpace": Y,
                 "sessions": [{"lastModified": 10**10, "tab": {"sessionId": "s1", "url": "u1", "title": "A"}}], "store": {"deletedSpaces": [self.ENTRY]}}
        state.update(over)
        entry = over.pop("entry", None) or self.ENTRY
        return runtime("return edit.undelete(" + json.dumps(entry) + ", 8);", **state)

    def healed(self, id, url, window=7, space=0, frm=Y):
        return {"id": id, "windowId": window, "index": 5, "url": url, "vivExtData": json.dumps({**({"workspaceId": space} if space else {}), "healedFrom": frm})}

    def test_the_heal_tagged_tab_is_taken_back_and_its_tag_cleared(self):
        r = self.undelete([self.healed(77, "u2")])
        self.assertNotIn("u2", [c[1] for c in r["calls"] if c[0] == "tabs.create"], "not opened twice")
        self.assertIn(["setSpace", 77, Y, 7, None], r["calls"], "back into its space")
        self.assertTrue(any(c[0] == "ext" and c[1] == 77 and c[2].get("healedFrom", "absent") is None for c in r["calls"]), "the tag is cleared")
        self.assertEqual(r["out"]["tabs"], 2)

    def test_after_a_restart_too(self):
        old = {**self.ENTRY, "run": "earlier"}
        r = self.undelete([self.healed(77, "u2", window=8)], entry=old, store={"deletedSpaces": [old]}, restoreInto=8)
        self.assertIn(["setSpace", 77, Y, 8, None], r["calls"])
        self.assertNotIn("u2", [c[1] for c in r["calls"] if c[0] == "tabs.create"])

    def test_an_untagged_default_tab_at_the_same_address_is_left_alone(self):
        plain = {"id": 78, "windowId": 7, "index": 5, "url": "u2", "vivExtData": "{}"}
        r = self.undelete([plain])
        self.assertIn(["tabs.create", "u2", 7, False], r["calls"], "u2 is opened anew")
        self.assertFalse(any(c[0] in ("setSpace", "ext") and c[1] == 78 for c in r["calls"]), "the user's own tab is never taken")

    def test_a_tagged_tab_the_user_moved_into_another_space_is_left_alone(self):
        r = self.undelete([self.healed(79, "u2", space=Z)])
        self.assertIn(["tabs.create", "u2", 7, False], r["calls"])
        self.assertFalse(any(c[0] in ("setSpace", "ext") and c[1] == 79 for c in r["calls"]))

    def test_a_tag_from_another_space_is_not_this_one(self):
        r = self.undelete([self.healed(80, "u2", frm=X)])
        self.assertFalse(any(c[0] in ("setSpace", "ext") and c[1] == 80 for c in r["calls"]))

    def test_back_already_is_dead_id_tabs_and_tagged_default_tabs(self):
        tabs = [tab(1, 7, Y), self.healed(2, "a"), self.healed(3, "b", space=Z), {"id": 4, "windowId": 7, "url": "c", "vivExtData": "{}"},
                self.healed(5, "d", frm=X), {"id": 6, "windowId": 7, "url": "e", "vivExtData": json.dumps({"healedFrom": "102"})}]
        self.assertEqual(run("return edit.backAlready(t, 102).map((x) => x.id);", t=tabs), [1, 2])

    def test_the_pre_pass_takes_every_tab_of_the_space_in_another_window_out_matched_or_not(self):
        # tab 81 carries Y in window 8 and matches no stored tab (navigated since): it leaves the space there first
        unmatched = {"id": 81, "windowId": 8, "index": 3, "url": "navigated-away", "vivExtData": json.dumps({"workspaceId": Y})}
        r = self.undelete([unmatched])
        moves = [c for c in r["calls"] if c[0] == "setSpace"]
        self.assertEqual(moves[0], ["setSpace", 81, 0, 8, None], "out of the space in its own window, before any tab goes in")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class FixRound1(unittest.TestCase):
    """Task 9c fix round 1 (review-9c-agy.md)."""
    ENTRY = DeleteAndUndelete.ENTRY

    def undelete(self, entry=None, **over):
        return DeleteAndUndelete.undelete(self, entry, **over)

    def test_a_private_window_edits_deletes_makes_and_brings_back_nothing(self):
        for expr in ["edit.remember(102)", "edit.undelete(" + json.dumps(self.ENTRY) + ", 8)", "edit.create('N')",
                     "edit.rename(101, 'W', { id: 'fx', title: 'X' })", "edit.setOrder([103, 101])", "edit.setIcon(101, 2)", "edit.setEmoji(101, 'x')"]:
            r = runtime("return " + expr + ";", list=LIST, tabs=DeleteAndUndelete.TABS, incognito=True, store={"deletedSpaces": [self.ENTRY]})
            self.assertEqual(r.get("threw"), "Edit, delete and bring back spaces from a normal window", expr)
            self.assertEqual([c for c in r["calls"] if c[0] != "warn"], [], f"{expr}: nothing touched")
            self.assertEqual(len(r["store"]["deletedSpaces"]), 1)

    def test_a_tab_of_the_space_in_another_window_leaves_it_there_before_any_tab_goes_in(self):
        # after a restart (another run): the asking window 8 is the target, and a reopened tab of the space sits in window 7
        live = {"id": 77, "windowId": 7, "index": 3, "url": "u2", "active": True, "vivExtData": json.dumps({"workspaceId": Y})}
        old = {**self.ENTRY, "run": "earlier"}
        r = self.undelete(entry=old, store={"deletedSpaces": [old]}, restoreInto=8, tabs=[tab(1, 7, 0, 0), tab(9, 8, 0, 0), live])
        c = [x for x in r["calls"] if x[0] in ("setSpace", "restore", "tabs.create", "tabs.update")]
        first = c.index(["setSpace", 77, 0, 7, None])
        self.assertLess(first, c.index(["restore", "s1"]), "out of the space in its own window before anything is restored")
        self.assertLess(c.index(["tabs.update", 1, {"active": True}]), first, "its window's own tab took the screen first")
        self.assertIn(["setSpace", 77, Y, 8, None], c, "then into the space in the target window")

    def test_only_a_window_the_restore_made_is_closed(self):
        r = self.undelete(restoreMakesWindow=True, userWindowAt=1)
        self.assertIn(["windows.remove", 50], r["calls"], "the restore's own window, left with a blank tab")
        self.assertNotIn(["windows.remove", 60], r["calls"], "a window the user opened meanwhile stays")

    def test_pinned_is_put_back_on_a_restored_tab(self):
        pinned = {**self.ENTRY, "tabs": [{**self.ENTRY["tabs"][0], "pinned": True}]}
        r = self.undelete(entry=pinned, store={"deletedSpaces": [pinned]})
        self.assertIn(["tabs.update", 500, {"pinned": True}], r["calls"])

    def test_a_failed_folder_rollback_is_said(self):
        r = runtime("try { await edit.rename(101, 'Work', { id: 'fx', title: 'Arc - X' }); } catch (e) { return e.message; }", list=LIST, nameIgnored=True, folderFails=True)
        self.assertEqual(r["out"], "Vivaldi did not take the new name")
        self.assertTrue(any(c[0] == "warn" and "keeps the name" in c[1] for c in r["calls"]), r["calls"])



@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class FinalFixRound(unittest.TestCase):
    """Final review (Codex Important 2 and 3, AGY minor 2): a tab is counted back, and its healedFrom tag cleared, only once
    it is verified in the space in the target window; what did not come back stays in a retryable entry; a window is closed
    only when the restore's own result shows it made it."""
    ENTRY = DeleteAndUndelete.ENTRY

    def undelete(self, entry=None, **over):
        return DeleteAndUndelete.undelete(self, entry, **over)

    def healed(self, id, url, window=7):
        return {"id": id, "windowId": window, "index": 5, "url": url, "vivExtData": json.dumps({"healedFrom": Y})}

    def kept(self, r):
        return [[t["url"], t["sessionId"]] for t in r["store"]["deletedSpaces"][0]["tabs"]] if r["store"]["deletedSpaces"] else None

    def test_a_healed_tab_that_does_not_go_back_keeps_its_tag_and_is_not_counted(self):
        for knob in ("placeFails", "placeThrows"):
            r = self.undelete(tabs=[tab(1, 7, 0, 0), tab(9, 8, 0, 0), self.healed(77, "u2")], **{knob: ["u2"]})
            self.assertFalse(any(c[0] == "ext" and c[1] == 77 and "healedFrom" in c[2] for c in r["calls"]), f"{knob}: the tag stays")
            self.assertEqual(r["out"]["tabs"], 1, knob)
            self.assertEqual(r["out"]["failed"], 1, knob)
            self.assertEqual(self.kept(r), [["u2", None]], f"{knob}: u2 stays in the entry, to try again")

    def test_a_tab_that_cannot_be_made_stays_in_the_entry(self):
        # u1's Recently Closed restore fails and so does its new tab; u2 comes back
        r = self.undelete(restoreFails=True, createFails=["u1"])
        self.assertEqual(r["out"]["tabs"], 1)
        self.assertEqual(r["out"]["failed"], 1)
        self.assertEqual(self.kept(r), [["u1", "s1"]], "u1 stays, with its Recently Closed id (it may still be listed)")
        self.assertEqual(r["store"]["deletedSpaces"][0]["deletedAt"], self.ENTRY["deletedAt"], "the same entry, retryable")

    def test_a_new_tab_that_does_not_go_into_the_space_is_closed_again_and_kept(self):
        r = self.undelete(placeFails=["u2"])
        made = [c for c in r["calls"] if c[0] == "tabs.create" and c[1] == "u2"]
        self.assertEqual(len(made), 1)
        self.assertIn(["tabs.remove", 501], r["calls"], "the new tab that stayed out of the space is closed: a retry opens it again")
        self.assertEqual(self.kept(r), [["u2", None]])

    def test_a_restored_tab_that_does_not_go_in_is_tagged_so_a_retry_takes_it(self):
        # u1 is restored from Recently Closed into window 7's default space, and its move into Y does nothing
        r = self.undelete(restoredSpace=0, placeFails=["u1"])
        self.assertIn(["ext", 500, {"healedFrom": Y}], r["calls"], "tagged: a retry finds it with backAlready, never opens it twice")
        self.assertEqual(self.kept(r), [["u1", None]], "its Recently Closed entry is used up")
        self.assertNotIn(["tabs.remove", 500], r["calls"], "a restored tab is never closed")

    def test_a_restored_tab_left_in_another_named_space_goes_to_its_default_space_tagged(self):
        # review of the final fix round, minor 2: Vivaldi restored u1 into space Z and the move into Y did nothing; a tab
        # left in Z would be neither taken back nor reopened by a retry without opening it twice
        r = self.undelete(restoredSpace=Z, placeFails=["u1"])
        self.assertIn(["setSpace", 500, 0, 7, None], r["calls"], "out of Z, into its window's default space")
        self.assertIn(["ext", 500, {"healedFrom": Y}], r["calls"])
        self.assertEqual(self.kept(r), [["u1", None]])

    def test_a_retry_after_a_partial_failure_brings_the_rest_back(self):
        first = self.undelete(placeFails=["u2"])
        retry = self.undelete(entry=first["store"]["deletedSpaces"][0], store=first["store"], list=[LIST[0], LIST[1], LIST[2]])
        self.assertIn(["tabs.create", "u2", 7, False], retry["calls"])
        self.assertEqual(retry["out"]["failed"], 0)
        self.assertEqual(retry["store"]["deletedSpaces"], [], "all back: the entry goes")

    def test_the_partial_note(self):
        self.assertEqual(run("return edit.partialNote({ name: 'Y' }, 1);"), "\u201cY\u201d is back, but 1 tab did not come back: Recently Deleted Spaces can try again")
        self.assertEqual(run("return edit.partialNote({ name: 'Y' }, 3);"), "\u201cY\u201d is back, but 3 tabs did not come back: Recently Deleted Spaces can try again")

    def test_a_blank_window_the_user_opens_during_the_restore_is_left_alone(self):
        r = self.undelete(userWindowDuringRestore=True)
        self.assertNotIn(["windows.remove", 61], r["calls"], "opened between the two window reads, but not the restore's")

    def test_a_window_the_restore_made_still_closes(self):
        r = self.undelete(restoreMakesWindow=True)
        self.assertIn(["windows.remove", 50], r["calls"])

# 18-empty-space.js's runtime against fake tab events: the window's tabs (S.tabs), Vivaldi's record (S.rec: the space window
# 7 shows), S.getDelay: how long chrome.tabs.get takes (ms). The script fires events through `fire`.
KEEPER = """
const fs = require("fs"), vm = require("vm"), path = require("path");
const input = JSON.parse(process.argv[2]);
const S = input.state, calls = [];
const listeners = {};
const ev = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
const fire = (name, ...a) => (listeners[name] || []).forEach((fn) => fn(...a));
const tabs = S.tabs;
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
globalThis.console = { log: (...a) => calls.push(["log", a.join(" ")]), warn: (...a) => calls.push(["warn", a.map(String).join(" ")]), error() {} };
globalThis.chrome = {
  windows: { getCurrent: async () => ({ id: 7 }) },
  tabs: {
    query: async ({ windowId } = {}) => tabs.filter((t) => windowId == null || t.windowId === windowId),
    get: (id) => later(S.getDelay || 0, tabs.find((t) => t.id === id)),
    create: async (p) => { calls.push(["create", p]); const t = { id: 900, windowId: p.windowId, active: true, url: "chrome://vivaldi-webui/startpage", vivExtData: JSON.stringify(S.rec ? { workspaceId: S.rec } : {}) }; tabs.push(t); return t; },
    update: async (id, p) => calls.push(["update", id, p]),
    onCreated: ev("onCreated"), onAttached: ev("onAttached"), onDetached: ev("onDetached"), onActivated: ev("onActivated"),
    onUpdated: ev("onUpdated"), onMoved: ev("onMoved"), onRemoved: ev("onRemoved"),
  },
};
// the window's own input (press: a trusted pointerdown or keydown in window.html) and Vivaldi's shortcuts (shortcut: one
// pressed in window `w`), for the final review's "a newer gesture cancels the recovery" (Codex Important 4)
const docListeners = {};
globalThis.document = { addEventListener: (name, fn) => { (docListeners[name] ||= []).push(fn); } };
const press = (type = "pointerdown", over = {}) => (docListeners[type] || []).forEach((fn) => fn({ type, isTrusted: true, repeat: false, key: "a", ...over }));
const shortcuts = [];
const shortcut = (w = 7, key = "ctrl+1") => shortcuts.forEach((fn) => fn(key, key, w));
globalThis.window = { vivaldiWindowId: 7, __vm: { ready: Promise.resolve(true), openEmptySpace: async (id, w) => calls.push(["bar", id, w]),
  onShortcut: (fn) => shortcuts.push(fn),
  spaceRepair: { busy: () => false, gesture: () => () => {} },
  native: { hasSwitch: () => true, record: () => ({ activeIn: () => S.rec ?? 0 }), spaceIds: async () => S.known, setSpace: async () => {}, switchTo: async (w, sp) => { calls.push(["switch", w, sp]);
    // S.switchMakesTab: Vivaldi makes the empty space's start page a moment after its switch (A7)
    if (S.switchMakesTab) setTimeout(() => { for (const t of tabs) t.active = false; tabs.push({ id: 901, windowId: w, active: true, url: "chrome://vivaldi-webui/startpage", vivExtData: JSON.stringify({ workspaceId: sp }) }); }, 100); } } } };
for (const f of ["07-workspaces.js", "18-empty-space.js"]) vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], f), "utf8"));
(async () => {
  await later(20);
  eval(input.script);
  await later(S.tailMs || 400);
  process.stdout.write(JSON.stringify(calls));
})();
"""


def keeper(script, **state):
    result = subprocess.run(["node", "-e", KEEPER, JS_DIR, json.dumps({"state": state, "script": script})], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class EmptySpaceRuntime(unittest.TestCase):
    """18-empty-space.js through its event listeners (fix round 1: the handler once threw on a shadowed name)."""

    def state(self, **over):
        st = {"tabs": [tab(1, 7, 0, 0), tab(2, 7, X, 1, active=True)], "rec": X, "known": [X, Y]}
        st.update(over)
        return st

    CLOSE_X1 = """
      const i = tabs.findIndex((t) => t.id === 2); tabs.splice(i, 1); tabs[0].active = true;
      fire("onActivated", { tabId: 1, windowId: 7 }); fire("onRemoved", 2, { windowId: 7, isWindowClosing: false });
    """

    def test_the_last_page_closing_makes_the_blank_tab_and_opens_the_bar(self):
        calls = keeper(self.CLOSE_X1, **self.state())
        self.assertIn(["create", {"windowId": 7, "active": True}], calls)
        self.assertIn(["bar", 900, 7], calls)

    def test_a_tab_closed_before_its_lookup_answers_still_counts(self):
        # X1 was put on screen and closed at once: the lookup (300 ms here) has not answered; the cache from the window's
        # first read knows it
        script = """fire("onActivated", { tabId: 2, windowId: 7 });""" + self.CLOSE_X1
        calls = keeper(script, **self.state(tabs=[tab(1, 7, 0, 0, active=True), tab(2, 7, X, 1)], getDelay=300))
        self.assertIn(["create", {"windowId": 7, "active": True}], calls)

    def test_another_windows_close_and_a_closing_window_do_nothing(self):
        self.assertEqual([c for c in keeper("""fire("onRemoved", 2, { windowId: 8, isWindowClosing: false });""", **self.state()) if c[0] != "log"], [])
        self.assertEqual(keeper("""fire("onRemoved", 2, { windowId: 7, isWindowClosing: true });""", **self.state()), [])


    # Final review, Codex Important 4: a newer explicit gesture during the 150 ms wait cancels the recovery, and the plan is
    # checked again before the switch and before the bar opens.
    def stayed(self, calls):
        return [c for c in calls if c[0] in ("create", "switch", "bar", "update")]

    def test_a_space_picked_during_the_wait_is_not_undone(self):
        # X's last page closes; 60 ms later the user clicks Y's tile and Vivaldi records the window on Y
        script = self.CLOSE_X1 + """setTimeout(() => { press("pointerdown"); S.rec = 103; }, 80);"""
        self.assertEqual(self.stayed(keeper(script, **self.state(known=[X, Y, Z]))), [], "no switch back to X, no bar over Y")

    def test_a_key_or_vivaldis_shortcut_in_this_window_during_the_wait_cancels_too(self):
        for later in ['press("keydown", { key: "1", ctrlKey: true });', "shortcut(7);"]:
            script = self.CLOSE_X1 + "setTimeout(() => { " + later + " }, 80);"
            self.assertEqual(self.stayed(keeper(script, **self.state())), [], later)

    def test_the_record_moving_with_no_gesture_still_switches_back(self):
        # Vivaldi moving the window's record during the wait (to the space of the tab Chromium put on screen, or default) is
        # not the user's choice: the recovery goes on, as the "switch" plan is meant to (final fix round review, I2)
        for to in (0, 103):
            script = self.CLOSE_X1 + "setTimeout(() => { S.rec = " + str(to) + "; }, 80);"
            calls = keeper(script, **self.state(known=[X, Y, Z], switchMakesTab=True, tailMs=900))
            self.assertIn(["switch", 7, X], calls, f"record to {to}")
            self.assertIn(["bar", 901, 7], calls, f"record to {to}")

    def test_the_close_itself_and_other_windows_or_held_keys_do_not_cancel(self):
        # the close's own Ctrl+W shortcut arriving just after onRemoved; another window's shortcut; a held key repeating; a
        # bare modifier; an untrusted (scripted) press
        for later, at in [("shortcut(7, 'ctrl+w');", 5), ("shortcut(7, 'ctrl+w');", 120), ("shortcut(7, 'ctrl+f4');", 120), ("shortcut(8);", 80), ('press("keydown", { repeat: true });', 80),
                          ('press("keydown", { key: "Control" });', 80), ('press("pointerdown", { isTrusted: false });', 80)]:
            script = self.CLOSE_X1 + "setTimeout(() => { " + later + " }, " + str(at) + ");"
            calls = keeper(script, **self.state())
            self.assertIn(["create", {"windowId": 7, "active": True}], calls, later)
            self.assertIn(["bar", 900, 7], calls, later)

    def test_a_gesture_after_the_switch_starts_still_keeps_the_bar_shut(self):
        # the record moved off X before the close was seen: a switch back is planned; the user clicks while it looks for
        # the start page, so the bar does not open over what the user picked
        script = """
          const i = tabs.findIndex((t) => t.id === 2); tabs.splice(i, 1); tabs[0].active = true; S.rec = 0;
          fire("onActivated", { tabId: 1, windowId: 7 }); fire("onRemoved", 2, { windowId: 7, isWindowClosing: false });
          setTimeout(() => press("pointerdown"), 230);
        """
        calls = keeper(script, **self.state(switchMakesTab=True, tailMs=900))
        self.assertIn(["switch", 7, X], calls)
        self.assertNotIn("bar", [c[0] for c in calls])
        # the probe sees a bar at all: without the click it opens on the start page Vivaldi made
        calls = keeper(script.replace('setTimeout(() => press("pointerdown"), 230);', ""), **self.state(switchMakesTab=True, tailMs=900))
        self.assertIn(["bar", 901, 7], calls)

@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Bundled(unittest.TestCase):
    def test_new_files_are_in_the_bundle_order(self):
        names = sorted(os.listdir(JS_DIR))
        self.assertLess(names.index("07-workspaces.js"), names.index("08-space-edit.js"))
        self.assertLess(names.index("07-workspaces.js"), names.index("11-space-repair.js"))
        self.assertLess(names.index("17-peek.js") if "17-peek.js" in names else 0, names.index("18-empty-space.js"))


if __name__ == "__main__":
    unittest.main()
