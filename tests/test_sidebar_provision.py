"""Automatic bookmark provisioning (the first run's Vivarc structure, and a space's own folder with its Pinned folder the
first time Vivarc meets the space) runs only in a normal window (final review, Codex Important 5): a private window shares
the profile's bookmarks, and the rename mark that holds a space's folder back lives on its own background page there.
The real loadBookmarks / applySpace code is cut out of 10-sidebar.js (from `const STARTER_FAVORITES` to `const readWorkspaces`)
and run against fake bookmarks."""
import json
import os
import shutil
import subprocess
import unittest

from jsrun import JS_DIR

HARNESS = r"""
const fs = require("fs"), path = require("path");
const input = JSON.parse(process.argv[2]);
const src = fs.readFileSync(path.join(process.argv[1], "10-sidebar.js"), "utf8");
const from = src.indexOf("  const STARTER_FAVORITES"), to = src.indexOf("  const readWorkspaces");
if (from < 0 || to < from) { process.stdout.write(JSON.stringify({ error: "the provisioning code was not found" })); process.exit(0); }
const created = [];
let nextId = 100;
const root = { id: "0", children: [{ id: "1", title: "Bookmarks bar", children: input.bar || [] }] };
const all = () => { const out = []; const walk = (n) => { out.push(n); (n.children || []).forEach(walk); }; walk(root); return out; };
const chrome = {
  extension: { inIncognitoContext: !!input.incognito },
  bookmarks: {
    getTree: async () => [JSON.parse(JSON.stringify(root))],
    create: async (p) => { created.push(p.title); const n = { id: String(nextId++), parentId: p.parentId, title: p.title, ...(p.url ? { url: p.url } : { children: [] }) };
      all().find((x) => x.id === p.parentId).children.push(n); return n; },
  },
};
const cfg = { spaceFolderTitle: "Vivarc", startUrl: "" };
const openFolders = new Set(), saveOpen = () => {};
const findSpaces = (tree) => (tree[0].children[0].children || []).filter((c) => c.children && c.title.startsWith("Vivarc") || (input.spaceTitles || []).includes(c.title));
const spacesOf = { assign: (folders) => { const base = folders.find((f) => f.title === "Vivarc") || null;
  return { default: base, byId: Object.fromEntries((input.workspaces || []).map((w) => [w.id, folders.find((f) => f.title === w.name) || null])) }; } };
const state = { workspaces: input.workspaces || [], active: input.active ?? null, folders: [] };
const window = { __vm: { spaceEdit: { renaming: () => false } } };
const run = new Function("chrome", "cfg", "openFolders", "saveOpen", "findSpaces", "spacesOf", "state", "window",
  src.slice(from, to) + "\nreturn { loadBookmarks, applySpace };");
const { loadBookmarks, applySpace } = run(chrome, cfg, openFolders, saveOpen, findSpaces, spacesOf, state, window);
(async () => {
  await loadBookmarks();
  await applySpace();
  process.stdout.write(JSON.stringify({ created, pinned: state.pinned ? state.pinned.title : null }));
})().catch((e) => process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })));
"""

BASE = {"id": "10", "parentId": "1", "title": "Vivarc", "children": [{"id": "11", "title": "Favorites", "children": []}, {"id": "12", "title": "Pinned", "children": []}]}


def provision(**opts):
    result = subprocess.run(["node", "-e", HARNESS, JS_DIR, json.dumps(opts)], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Provisioning(unittest.TestCase):
    def test_a_normal_window_makes_the_first_run_structure(self):
        r = provision()
        self.assertNotIn("error", r, r)
        self.assertEqual(r["created"][:2], ["Vivarc", "Favorites"])
        self.assertIn("Pinned", r["created"])

    def test_a_private_window_makes_no_first_run_structure(self):
        self.assertEqual(provision(incognito=True), {"created": [], "pinned": None})

    def test_a_normal_window_makes_a_new_spaces_folder_and_pinned(self):
        r = provision(bar=[BASE], workspaces=[{"id": 5, "name": "Work"}], active=5, spaceTitles=["Work"])
        self.assertEqual(r["created"], ["Work", "Pinned"])

    def test_a_private_window_makes_no_folder_for_a_space(self):
        r = provision(bar=[BASE], workspaces=[{"id": 5, "name": "Work"}], active=5, spaceTitles=["Work"], incognito=True)
        self.assertEqual(r["created"], [])


if __name__ == "__main__":
    unittest.main()
