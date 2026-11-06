// Every rule of docs/vivarc-rules.md Part 2 (and Part 3's decisions), checked live in the sandbox Vivaldi that
// tools/sandbox.ps1 launches. Each case starts from a clean state (one window, no spaces), builds its setup, acts,
// waits until things settle, then asserts the expected snapshot AND the two invariants over every normal window:
// the record's space is the active tab's space, and no named space has tabs in more than one window.
// It prints one PASS/FAIL line per rule ID. Port 9333 only (sandbox-lib.mjs refuses any other).
//
//   pwsh -NoProfile -File tools/sandbox.ps1            # a sandbox running this checkout's Vivarc
//   node tools/sandbox-rules.mjs                       # Dia: every rule; Arc: the tile rows and the Dia button's absence
//   node tools/sandbox-rules.mjs --layout dia --only T.,R.D8 --log <dir> --extra
//     --layout dia|arc|both (default both)   --only a comma list of ID prefixes   --log a folder for one JSON per case
//     --extra adds R.D8-min-leader: D8 with the leader window minimised (are its timers throttled?)
//
// Setups are the ones the build measured with (task probes): H is the window the sandbox opened (the lowest id, so the
// repair leader), W and O are windows it makes, X/Y/Z are spaces, X1@W is a tab labelled X1 in W. While a setup builds
// a state the repairs would fix at once (a split), it raises the shared busy mark tile gestures use, so repairs wait.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { Harness, sleep, tabUrl } from "./sandbox-lib.mjs";

const J = JSON.stringify;
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback; };
const LAYOUT = opt("--layout", "both");
const ONLY = (opt("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const LOGDIR = opt("--log", null);
const EXTRA = args.includes("--extra");
if (LOGDIR) mkdirSync(LOGDIR, { recursive: true });

const h = new Harness();
const ctx = { H: null, roles: {}, tabs: {}, spaces: {} };
const BUSY = "__vivarcSpaceGesture"; // 11-space-repair.js: repairs wait while it stands (shared background page)

// ---------- setup primitives ----------
// busy() raises the mark for 9.5 s; unbusy() lowers it only if it is still ours (a pull or a move to a new window
// started meanwhile has put its own, which it clears itself), then nudges every window's repair scheduler.
const busy = async () => { ctx.busyMark = Date.now() + 9500; return h.ev(`(chrome.extension.getBackgroundPage()[${J(BUSY)}] = ${ctx.busyMark}, 1)`, ctx.H); };
const unbusy = async (force = false) => {
  await h.ev(`(() => { const bg = chrome.extension.getBackgroundPage(); if (${force} || bg[${J(BUSY)}] === ${ctx.busyMark ?? 0}) delete bg[${J(BUSY)}]; return 1; })()`, ctx.H);
  await h.refresh();
  for (const e of h.byWin.values()) await e.cdp.eval(`(window.__vm?.spaceRepair?.schedule(), 1)`).catch(() => {});
};
const busyLeft = () => h.ev(`Math.max(0, (Number(chrome.extension.getBackgroundPage()[${J(BUSY)}]) || 0) - Date.now())`, ctx.H);
const waitFor = async (fn, ms = 8000, every = 200) => {
  const end = Date.now() + ms; let v;
  while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(every); }
  return v;
};

let server = null, origin = null;
const startServer = async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>page${req.url}</title>page ${req.url}`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
};

async function start() {
  await h.refresh();
  ctx.H = Math.min(...h.byWin.keys());
  h.driver = ctx.H;
}

// One window (H) on its default space with one default tab, no spaces, no test bookmarks.
async function reset() {
  await busy();
  await h.refresh();
  const H = ctx.H;
  await h.ev(`chrome.windows.update(${H}, { state: "normal" }).then(() => 1, () => 0)`, H);
  let s = await h.snap(H);
  for (const [id] of s.spaces) await h.ev(`window.__sbx.mgr.removeWorkspace(${H}, ${id}).then(() => 1, () => 0)`, H);
  await sleep(500);
  s = await h.snap(H);
  for (const w of s.wins) if (w.id !== H) await h.ev(`chrome.windows.remove(${w.id}).then(() => 1, () => 0)`, H);
  await sleep(800);
  s = await h.snap(H);
  const hw = s.wins.find((w) => w.id === H);
  if (!hw.tabs.some((t) => t.ws == null || t.ws === 0)) await h.ev(`chrome.tabs.create({ windowId: ${H}, url: ${J(tabUrl("H-d0"))} }).then(() => 1)`, H);
  s = await h.snap(H);
  const keep = s.wins.find((w) => w.id === H).tabs.find((t) => t.ws == null || t.ws === 0).id;
  const extra = s.wins.find((w) => w.id === H).tabs.filter((t) => t.id !== keep).map((t) => t.id);
  if (extra.length) await h.ev(`chrome.tabs.remove(${J(extra)}).then(() => 1, () => 0)`, H);
  if (s.perWin[H] != null) await h.switchTo(H, undefined, H);
  if (origin) await h.ev(`chrome.bookmarks.search({}).then(async (all) => { for (const n of all) if (n.url && n.url.startsWith(${J(origin)})) await chrome.bookmarks.remove(n.id).catch(() => {}); return 1; })`, H).catch(() => {});
  await sleep(500);
  s = await h.snap(H);
  if ((await h.ev(`vivaldi.prefs.get("vivaldi.tabs.visible").then((r) => r?.value ?? r)`, H)) === false) await h.ev(`vivaldi.prefs.set({ path: "vivaldi.tabs.visible", value: true }).then(() => 1)`, H);
  ctx.roles = { H }; ctx.tabs = {}; ctx.spaces = {};
  for (const k of ["W", "O", "V", "N"]) delete ctx[k];
  await unbusy(true);
  return s.wins.length === 1 && s.all.length === 0 && s.spaces.length === 0 && s.wins[0].tabs.length === 1;
}

async function mkSpaces(names = ["X", "Y", "Z"]) {
  const base = Date.now();
  ctx.spaces = Object.fromEntries(names.map((n, i) => [n, base + i + 1]));
  await h.ev(`(() => { const s = window.__sbx; const ic = s.ws.getDefaultIcon?.();
    for (const [n, id] of ${J(Object.entries(ctx.spaces))}) s.mgr.addWorkspaceWithId(id, n, ic, ""); return 1; })()`, ctx.H);
  await sleep(300);
}

const LEFT = { W: 40, O: 760, V: 400 };
async function mkWin(role, { width = 700 } = {}) {
  const id = await h.ev(`chrome.windows.create(${J({ url: tabUrl(`${role}-d0`), focused: true, left: LEFT[role] ?? 200, top: 60, width, height: 640 })}).then(w => w.id)`, ctx.H);
  ctx[role] = id; ctx.roles[role] = id;
  await h.waitForWin(id);
  await sleep(600);
  return id;
}

async function tab(win, label, space, { active = false } = {}) {
  const p = { windowId: win, url: tabUrl(label), active };
  if (space) p.vivExtData = J({ workspaceId: space });
  const id = await h.ev(`chrome.tabs.create(${J(p)}).then(t => t.id)`, ctx.H);
  ctx.tabs[label] = id;
  return id;
}
const show = async (win, space) => { await h.switchTo(win, space ?? undefined, ctx.H); await sleep(300); };
const activate = (id) => h.ev(`chrome.tabs.update(${id}, { active: true }).then(() => 1)`, ctx.H);
const focus = async (win) => { await h.ev(`chrome.windows.update(${win}, { focused: true }).then(() => 1)`, ctx.H); await sleep(400); };

// ---------- the sidebar, driven as a user would ----------
const PILL = (sel) => `[...document.querySelectorAll(".vm-space-pill")].find((b) => ${sel})`;
const pillOf = (name) => name === "default" ? PILL(`(b.getAttribute("aria-label") || "").includes("this window's own tabs")`)
  : PILL(`(b.getAttribute("aria-label") || "").startsWith(${J(name + " ·")})`);
const waitTile = (win, name) => waitFor(() => h.ev(`!!${pillOf(name)}`, win), 8000);
async function clickTile(win, name, { shift = false, ctrl = false } = {}) {
  if (!(await waitTile(win, name))) return "no tile";
  return h.ev(`(() => { const p = ${pillOf(name)}; p.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: ${shift}, ctrlKey: ${ctrl} })); return "clicked"; })()`, win);
}
const dotted = (win) => h.ev(`[...document.querySelectorAll(".vm-space-pill.elsewhere")].map((b) => (b.getAttribute("aria-label") || "").split(" ·")[0])`, win);

// A tab row's right-click menu: the labels it lists; then the item `label` is clicked and a toast, if any, is read.
async function tabMenu(win, row, label) {
  const menu = await waitFor(() => h.ev(`(() => { const r = [...document.querySelectorAll(".vm-tab")].find((r) => r.textContent.includes(${J(row)}));
    if (!r) return null; const b = r.getBoundingClientRect();
    r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8 }));
    return [...document.querySelectorAll(".vm-menu > div")].map((d) => d.textContent); })()`, win), 8000);
  if (!menu) return { error: `no sidebar row ${row}` };
  await sleep(200);
  const clicked = await h.ev(`(() => { const i = [...document.querySelectorAll(".vm-menu-item")].find((d) => d.textContent === ${J(label)}); if (!i) return false; i.click(); return true; })()`, win);
  if (!clicked) {
    await h.ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`, win);
    return { error: `no menu item "${label}" (menu: ${J(menu.filter(Boolean))})`, menu };
  }
  const toast = await waitFor(() => h.ev(`document.querySelector("#vm-copied")?.textContent || null`, win), 2500, 100);
  return { menu, toast: toast || null };
}

// A space tile's right-click: the delete confirmation's first label, then Cancel.
async function deleteLabel(win, name) {
  if (!(await waitTile(win, name))) return { error: "no tile" };
  const label = await h.ev(`(async () => { const p = ${pillOf(name)}; const b = p.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4 }));
    for (let i = 0; i < 30; i++) { const m = document.querySelector(".vm-menu .vm-menu-item"); if (m) return m.textContent; await new Promise((r) => setTimeout(r, 100)); }
    return null; })()`, win);
  await h.ev(`(() => { const c = [...document.querySelectorAll(".vm-menu-item")].find((d) => d.textContent === "Cancel"); if (c) c.click(); return 1; })()`, win);
  return { label };
}

// Favorites and pins: bookmark folders Vivarc keeps (a space's folder holds "Pinned"; the default's also "Favorites").
const folders = () => h.ev(`chrome.bookmarks.getTree().then((tree) => { const out = {}; const walk = (n) => { for (const c of n.children || []) {
  if (c.children && c.children.some((k) => k.children && k.title === "Pinned")) out[c.title] = { id: c.id,
    pinned: c.children.find((k) => k.children && k.title === "Pinned")?.id, favs: c.children.find((k) => k.children && k.title === "Favorites")?.id };
  walk(c); } }; walk(tree[0]); return out; })`, ctx.H);
async function favoritesFolder() {
  const f = await waitFor(async () => { const all = await folders(); return Object.keys(all).some((k) => !(k in ctx.spaces)) ? all : null; });
  if (!f) throw new Error("no default space folder");
  const [, base] = Object.entries(f).find(([k]) => !(k in ctx.spaces));
  return base.favs ?? h.ev(`chrome.bookmarks.create({ parentId: ${J(base.id)}, title: "Favorites", index: 0 }).then((n) => n.id)`, ctx.H);
}
const bookmark = (parentId, title, url) => h.ev(`chrome.bookmarks.create({ parentId: ${J(parentId)}, title: ${J(title)}, url: ${J(url)} }).then((n) => n.id)`, ctx.H);
const clickFav = (win, title) => waitFor(() => h.ev(`(() => { const n = [...document.querySelectorAll("#vm-panel .vm-fav")].find((t) => t.title === ${J(title)}); if (!n) return false; n.click(); return true; })()`, win));
const clickPin = (win, url, title) => waitFor(() => h.ev(`(() => { const r = [...document.querySelectorAll("#vm-panel .vm-row.vm-link")].find((r) => r.title.includes(${J(url)}) || r.textContent.includes(${J(title)}));
  if (!r) return false; r.click(); return true; })()`, win));
const tabsFor = (s, url) => s.wins.flatMap((w) => w.tabs.filter((t) => t.url.startsWith(url)).map((t) => ({ ...t, win: w.id })));

// ---------- snapshot reading ----------
const normal = (s) => s.wins.filter((w) => w.type === "normal");
const roleOf = (id) => Object.entries(ctx.roles).find(([, v]) => v === id)?.[0] ?? `win${id}`;
const spaceName = (id) => (id == null || id === 0) ? "default" : (Object.entries(ctx.spaces).find(([, v]) => v === id)?.[0] ?? `space${id}`);
const labelOf = (t) => Object.entries(ctx.tabs).find(([, v]) => v === t.id)?.[0]
  ?? (t.url.startsWith("data:") ? decodeURIComponent(t.url).replace(/^data:text\/html,<title>([^<]*)<.*$/, "$1") : /startpage|newtab/.test(t.url) ? "START" : t.url.slice(0, 40));
const find = (s, id) => { for (const w of s.wins) { const t = w.tabs.find((x) => x.id === id); if (t) return { ...t, win: w.id, space: t.ws ?? 0 }; } return null; };
const recOf = (s, win) => s.perWin[win] ?? 0;
const activeOf = (s, win) => { const t = s.wins.find((w) => w.id === win)?.tabs.find((x) => x.active); return t ? { ...t, space: t.ws ?? 0 } : null; };
const inSpace = (s, space) => normal(s).flatMap((w) => w.tabs.filter((t) => (t.ws ?? 0) === space).map((t) => ({ ...t, win: w.id })));
const newWindow = (s) => { const w = normal(s).find((x) => !Object.values(ctx.roles).includes(x.id)); if (w) { ctx.N = w.id; ctx.roles.N = w.id; } return w?.id ?? null; };

// The invariants, over normal windows (spec Part 2, invariants 2 and 3).
function invariants(s) {
  const bad = [];
  const where = new Map();
  for (const w of normal(s)) {
    const rec = recOf(s, w.id);
    const act = w.tabs.find((t) => t.active);
    if (act && (act.ws ?? 0) !== rec) bad.push(`${roleOf(w.id)} recorded ${spaceName(rec)} but shows ${labelOf(act)} of ${spaceName(act.ws)}`);
    for (const t of w.tabs) if (t.ws) (where.get(t.ws) || where.set(t.ws, new Set()).get(t.ws)).add(w.id);
  }
  for (const [space, wins] of where) if (wins.size > 1) bad.push(`${spaceName(space)} split across ${[...wins].map(roleOf).join(", ")}`);
  return bad;
}

// Readable state for logs and failure lines: per window, its record, active tab and tabs by space.
function digest(s) {
  const out = { focused: roleOf(s.lastFocused), record: Object.fromEntries(s.all.map(([w, win]) => [spaceName(w), roleOf(win)])), windows: {} };
  for (const w of normal(s)) {
    const g = {};
    for (const t of w.tabs) (g[spaceName(t.ws)] ||= []).push(labelOf(t) + (t.active ? "*" : ""));
    out.windows[roleOf(w.id)] = { on: spaceName(s.perWin[w.id]), tabs: g };
  }
  return out;
}
const brief = (s) => Object.entries(digest(s).windows).map(([r, w]) => `${r}{on:${w.on} ${Object.entries(w.tabs).map(([k, v]) => `${k}:[${v.join(",")}]`).join(" ")}}`).join(" ") + ` focus:${roleOf(s.lastFocused)}`;

// Expectation helpers: each returns null (holds) or what is wrong.
const recIs = (s, win, space) => recOf(s, win) === (space || 0) ? null : `${roleOf(win)} recorded ${spaceName(recOf(s, win))}, want ${spaceName(space)}`;
const showsSpace = (s, win, space) => { const a = activeOf(s, win); return a && a.space === (space || 0) ? null : `${roleOf(win)} shows ${a ? labelOf(a) + " of " + spaceName(a.space) : "nothing"}, want a tab of ${spaceName(space)}`; };
const allIn = (s, space, win) => {
  if (win == null) return `no window to hold ${spaceName(space)}`;
  const ts = inSpace(s, space);
  if (!ts.length) return `${spaceName(space)} has no tabs`;
  const off = ts.filter((t) => t.win !== win);
  return off.length ? `${spaceName(space)} tabs ${off.map((t) => `${labelOf(t)}@${roleOf(t.win)}`).join(",")} not in ${roleOf(win)}` : null;
};
const focusIs = (s, win) => s.lastFocused === win ? null : `focus on ${roleOf(s.lastFocused)}, want ${roleOf(win)}`;
const tabIs = (s, label, { win, space, active } = {}) => {
  const t = find(s, ctx.tabs[label]);
  if (!t) return `${label} is gone`;
  const bad = [];
  if (win !== undefined && t.win !== win) bad.push(`in ${roleOf(t.win)} not ${roleOf(win)}`);
  if (space !== undefined && t.space !== (space || 0)) bad.push(`in ${spaceName(t.space)} not ${spaceName(space)}`);
  if (active !== undefined && t.active !== active) bad.push(active ? "not active" : "active");
  return bad.length ? `${label} ${bad.join(", ")}` : null;
};
// Nothing moved: every tab in the same window and space, the same record, the same active tab per window.
const unchanged = (b, s) => {
  const bad = [];
  for (const w of normal(b)) for (const t of w.tabs) {
    const now = find(s, t.id);
    if (!now) bad.push(`${labelOf(t)} closed`);
    else if (now.win !== w.id || now.space !== (t.ws ?? 0)) bad.push(`${labelOf(t)} moved to ${roleOf(now.win)}/${spaceName(now.space)}`);
  }
  if (J(b.all) !== J(s.all)) bad.push(`record ${J(digest(b).record)} became ${J(digest(s).record)}`);
  for (const w of normal(b)) { const a = activeOf(b, w.id), n = activeOf(s, w.id); if (a?.id !== n?.id) bad.push(`${roleOf(w.id)} active ${a && labelOf(a)} became ${n && labelOf(n)}`); }
  return bad.length ? bad.join("; ") : null;
};

// ---------- cases ----------
const C = [];
const def = (id, c) => C.push({ id, ...c });
const sp = (n) => ctx.spaces[n];

// Gesture-table setups (spec Part 2, "Gestures on a space tile"), all clicked in W.
const SET = {
  "shown-here": async () => { await mkWin("W"); await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W); },
  "shown-other": async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.O, "X1", sp("X"), { active: true }); await tab(ctx.O, "X2", sp("X")); await show(ctx.O, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W); },
  "parked-here": async () => { await mkWin("W"); await tab(ctx.W, "X1", sp("X")); await tab(ctx.W, "X2", sp("X")); await focus(ctx.W); },
  "parked-other": async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.O, "X1", sp("X")); await tab(ctx.O, "X2", sp("X")); await focus(ctx.W); },
  // split, shown in O: X1*, X2 in O (O shows X), X3 parked in W
  "split-shown": async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.O, "X1", sp("X"), { active: true }); await tab(ctx.O, "X2", sp("X")); await show(ctx.O, sp("X")); await activate(ctx.tabs.X1); await tab(ctx.W, "X3", sp("X")); await focus(ctx.W); },
  // split, shown nowhere: X1 in W, X2 and X3 in O (most), both windows on default
  "split-parked": async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.W, "X1", sp("X")); await tab(ctx.O, "X2", sp("X")); await tab(ctx.O, "X3", sp("X")); await focus(ctx.W); },
  empty: async () => { await mkWin("W"); await focus(ctx.W); },
};
const SPLIT = new Set(["split-shown", "split-parked"]);
const gesture = (row, col, expect) => def(`T.${row}.${col}`, {
  gesture: true, busyThroughAct: SPLIT.has(row), setup: SET[row],
  act: () => clickTile(ctx.W, "X", col === "shift" ? { shift: true } : col === "new" ? { shift: true, ctrl: true } : {}),
  expect,
});
const toNew = (holder) => (s) => { const n = newWindow(s); return [n == null ? "no new window" : null, allIn(s, sp("X"), n), n != null ? recIs(s, n, sp("X")) : null, holder ? recIs(s, ctx[holder], 0) : null]; };
gesture("shown-here", "click", (s, b) => [unchanged(b, s)]);
gesture("shown-here", "shift", (s, b) => [unchanged(b, s)]);
gesture("shown-here", "new", toNew("W"));
gesture("shown-other", "click", (s, b) => [unchanged(b, s), focusIs(s, ctx.O)]);
gesture("shown-other", "shift", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, 0)]);
gesture("shown-other", "new", toNew("O"));
gesture("parked-here", "click", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X"))]);
gesture("parked-here", "shift", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X"))]);
gesture("parked-here", "new", toNew("W"));
gesture("parked-other", "click", (s) => [allIn(s, sp("X"), ctx.O), recIs(s, ctx.O, sp("X")), recIs(s, ctx.W, 0), focusIs(s, ctx.O)]);
gesture("parked-other", "shift", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, 0)]);
gesture("parked-other", "new", toNew(null));
gesture("split-shown", "click", (s) => [allIn(s, sp("X"), ctx.O), recIs(s, ctx.O, sp("X")), recIs(s, ctx.W, 0), focusIs(s, ctx.O)]);
gesture("split-shown", "shift", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, 0)]);
gesture("split-shown", "new", toNew("O"));
gesture("split-parked", "click", (s) => [allIn(s, sp("X"), ctx.O), recIs(s, ctx.O, sp("X")), recIs(s, ctx.W, 0), focusIs(s, ctx.O)]);
gesture("split-parked", "shift", (s) => [allIn(s, sp("X"), ctx.W), recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, 0)]);
gesture("split-parked", "new", toNew(null));
gesture("empty", "click", (s) => [recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]);
gesture("empty", "shift", (s) => [recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]);
gesture("empty", "new", (s) => { const n = newWindow(s); return [n == null ? "no new window" : null, n != null ? recIs(s, n, sp("X")) : null, n != null ? showsSpace(s, n, sp("X")) : null]; });
def("T.default.click", {
  gesture: true, setup: SET["shown-here"], act: () => clickTile(ctx.W, "default"),
  expect: (s) => [recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), allIn(s, sp("X"), ctx.W)],
});

// Dots: a tile is dotted when its space lives in another window, shown or parked there.
def("DOTS", {
  gesture: true,
  setup: async () => {
    await mkWin("W"); await mkWin("O");
    await tab(ctx.O, "X1", sp("X"), { active: true }); await show(ctx.O, sp("X")); await activate(ctx.tabs.X1);
    await tab(ctx.O, "Y1", sp("Y")); await tab(ctx.W, "Z1", sp("Z")); await focus(ctx.W);
  },
  act: async () => (await waitFor(async () => { const d = await dotted(ctx.W); return J([...d].sort()) === J(["X", "Y"]) ? d : null; }, 7000)) ?? dotted(ctx.W),
  expect: (s, b, dots) => [J([...dots].sort()) === J(["X", "Y"]) ? null : `dotted tiles ${J(dots)}, want X and Y (not Z, not the default)`],
});

// Repairs (spec Part 2, "Repairs"), set up as Task 6 measured them.
def("R.D8", {
  busyThroughAct: true, timed: true,
  setup: async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X")); await tab(ctx.O, "X2", sp("X")); await focus(ctx.W); await focus(ctx.H); await focus(ctx.O); },
  act: () => h.ev(`chrome.windows.remove(${ctx.O}).then(() => "ok")`, ctx.H),
  expect: (s) => [tabIs(s, "X1", { win: ctx.W, space: sp("X") }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X")), recIs(s, ctx.H, 0)],
});
def("R.F2", {
  timed: true,
  setup: async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.O, "X1", sp("X"), { active: true }); await tab(ctx.O, "X2", sp("X")); await show(ctx.O, sp("X")); await focus(ctx.W); },
  act: () => h.ev(`window.__sbx.mgr.removeWorkspace(${ctx.W}, ${sp("X")}).then(() => "ok", e => "err:" + e)`, ctx.W),
  expect: (s) => [recIs(s, ctx.O, 0), showsSpace(s, ctx.O, 0), recIs(s, ctx.W, 0), inSpace(s, sp("X")).length ? "X tabs left" : null],
});
def("R.C3", {
  timed: true,
  setup: async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X")); await focus(ctx.W); },
  act: () => h.ev(`chrome.tabs.move(${ctx.tabs.X1}, { windowId: ${ctx.O}, index: -1 }).then(() => "ok", e => "err:" + e)`, ctx.W),
  // W is left recorded on X with no X tab (C3) -> repair 1. X1 arrived in O by chrome.tabs.move from a window that
  // stays open, so the drag rule (decision 4) puts it in the space O shows: the default.
  expect: (s) => [recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), tabIs(s, "X1", { win: ctx.O, space: 0 }), recIs(s, ctx.O, 0)],
});
def("R.G1", {
  timed: true,
  setup: async () => { await mkWin("W"); await tab(ctx.W, "X1", sp("X")); await focus(ctx.W); },
  act: () => h.ev(`chrome.tabs.update(${ctx.tabs.X1}, { active: true }).then(() => "ok")`, ctx.W),
  expect: (s) => [recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), tabIs(s, "X1", { win: ctx.W, space: sp("X"), active: false })],
});
// Repair 4 / D2: a closing window's tabs rehome into the last-focused window, keep their space, and stay parked.
def("R.D2", {
  timed: true,
  setup: async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.O, "X1", sp("X"), { active: true }); await tab(ctx.O, "X2", sp("X")); await show(ctx.O, sp("X")); await focus(ctx.H); await focus(ctx.W); await focus(ctx.O); },
  act: () => h.ev(`chrome.windows.remove(${ctx.O}).then(() => "ok")`, ctx.H),
  expect: (s) => [tabIs(s, "X1", { win: ctx.W, space: sp("X") }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0)],
});
if (EXTRA) def("R.D8-min-leader", {
  busyThroughAct: true, timed: true,
  setup: async () => {
    await mkWin("W"); await mkWin("V"); await mkWin("O");
    await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X")); await tab(ctx.O, "X2", sp("X"));
    await focus(ctx.W); await focus(ctx.V); await focus(ctx.O);
    await h.ev(`chrome.windows.update(${ctx.H}, { state: "minimized" }).then((w) => w.state)`, ctx.H);
    await sleep(1500);
  },
  act: () => h.ev(`chrome.windows.remove(${ctx.O}).then(() => "ok")`, ctx.W),
  expect: async (s) => [tabIs(s, "X1", { win: ctx.W, space: sp("X") }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X")),
    (await h.ev(`chrome.windows.get(${ctx.H}).then((w) => w.state)`, ctx.W)) === "minimized" ? null : "the leader was not minimised"],
});

// A8b: a switch to the default space in a window with no default tab is not undone by a new tab's stamp.
def("A8b", {
  setup: async () => {
    await mkWin("W"); await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X"));
    const s = await h.snap(ctx.H); const d0 = s.wins.find((w) => w.id === ctx.W).tabs.find((t) => t.url.includes("W-d0"));
    await h.ev(`chrome.tabs.remove(${d0.id}).then(() => 1)`, ctx.H); await focus(ctx.W);
  },
  act: () => h.switchTo(ctx.W, undefined, ctx.W),
  expect: (s) => [recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), tabIs(s, "X1", { win: ctx.W, space: sp("X"), active: false })],
});

// The delete confirmation counts the space's tabs in every window (the split is held by the busy mark).
def("DEL.count", {
  busyThroughAct: true,
  setup: async () => { await mkWin("W"); await mkWin("O"); await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await tab(ctx.O, "X3", sp("X")); await focus(ctx.W); },
  act: () => deleteLabel(ctx.W, "X"),
  expect: (s, b, r) => [r.label === "Delete “X” and close its 3 tabs in 2 windows" ? null : `confirmation ${J(r.label ?? r.error)}, want "Delete “X” and close its 3 tabs in 2 windows"`, allIn(s, sp("X"), ctx.W)],
});

// Decision 3: favorites and pins open in the space on screen, and bring their bound tab (no duplicate).
const favCase = (id, how) => def(id, {
  setup: async () => {
    await mkWin("W", { width: 1000 });
    await tab(ctx.W, "X1", sp("X")); await tab(ctx.W, "Y1", sp("Y"));
    const first = how === "pin-moved" ? "Y" : "X";
    await show(ctx.W, sp(first)); await activate(ctx.tabs[first + "1"]); await focus(ctx.W);
    ctx.url = `${origin}/${id}-${Date.now()}`; ctx.title = id.toUpperCase();
    let parent;
    if (how === "pin-moved") {
      const f = await waitFor(async () => { const all = await folders(); return all.Y?.pinned ? all : null; });
      if (!f) throw new Error("no Pinned folder for Y");
      parent = f.Y.pinned;
    } else parent = await favoritesFolder();
    await bookmark(parent, ctx.title, ctx.url);
    const open = () => how === "pin-moved" ? clickPin(ctx.W, ctx.url, ctx.title) : clickFav(ctx.W, ctx.title);
    if (!(await open())) throw new Error("the favorite or pin is not in W's sidebar");
    const bound = await waitFor(async () => tabsFor(await h.snap(ctx.H), ctx.url)[0], 8000);
    if (!bound) throw new Error("opening it made no tab");
    ctx.tabs.BOUND = bound.id;
    await sleep(1500);
    if (how === "fav-space") await show(ctx.W, sp("Y"));
    if (how === "fav-default") await show(ctx.W, undefined);
    if (how === "fav-window") { await mkWin("V"); await tab(ctx.V, "Y1@V", sp("Y"), { active: true }); await show(ctx.V, sp("Y")); await activate(ctx.tabs["Y1@V"]); await focus(ctx.V); }
    if (how === "pin-moved") {
      await activate(ctx.tabs.Y1); await sleep(500);
      await h.ev(`chrome.tabs.get(${bound.id}).then((t) => { const d = JSON.parse(t.vivExtData || "{}"); d.workspaceId = ${sp("X")}; return chrome.tabs.update(t.id, { vivExtData: JSON.stringify(d) }); }).then(() => 1)`, ctx.H);
    }
    ctx.clickIn = how === "fav-window" ? ctx.V : ctx.W;
    ctx.wantSpace = how === "fav-default" ? 0 : sp("Y");
    await sleep(1500);
  },
  act: () => (how === "pin-moved" ? clickPin(ctx.clickIn, ctx.url, ctx.title) : clickFav(ctx.clickIn, ctx.title)).then((ok) => ok ? "clicked" : "not in the sidebar"),
  expect: (s, b, r) => {
    const ts = tabsFor(s, ctx.url);
    const t = ts[0];
    return [r === "clicked" ? null : `second click: ${r}`, ts.length === 1 ? null : `${ts.length} tabs for it (${ts.map((x) => `${roleOf(x.win)}/${spaceName(x.ws)}`).join(", ")}), want 1`,
      t && t.id !== ctx.tabs.BOUND ? "the bound tab was not the one used" : null,
      t ? tabIs(s, "BOUND", { win: ctx.clickIn, space: ctx.wantSpace, active: true }) : null,
      how === "fav-default" && t && t.ws !== null ? `vivExtData keeps workspaceId ${t.ws}, want no key` : null,
      recIs(s, ctx.clickIn, ctx.wantSpace)];
  },
});
favCase("P3.3-fav-other-space", "fav-space");
favCase("P3.3-fav-other-window", "fav-window");
favCase("P3.3-fav-default", "fav-default");
favCase("P3.3-pin-moved", "pin-moved");

// Decision 4: a tab dragged into another window joins the space it shows. Vivaldi's own drop (H2), and a move done
// another way (chrome.tabs.move, which keeps the space: C1) that Vivarc restamps.
const dragSetup = (oShows) => async () => {
  await mkWin("W"); await mkWin("O");
  await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
  if (oShows) { await tab(ctx.O, "Z1", sp("Z"), { active: true }); await show(ctx.O, sp("Z")); await activate(ctx.tabs.Z1); }
  await focus(ctx.W);
};
def("P3.4-drop", {
  setup: dragSetup(true),
  act: () => h.ev(`(async () => {
    const bg = chrome.extension.getBackgroundPage(); let load; bg.webpackChunkgapp_browser_react.push([[Symbol("d")], {}, (q) => { load = q; }]);
    const find = (marker, method) => { for (const [id, f] of Object.entries(load.m)) { if (!String(f).includes(marker)) continue; let m; try { m = load(id); } catch (_) { continue; }
      for (const v of Object.values(m || {})) if (v && typeof v[method] === "function") return v; } return null; };
    const actions = find("moveDroppedTabs:async function", "moveDroppedTabs"), pages = find("getPageById(e){", "getPages");
    if (!actions || !pages) return "Vivaldi's drop not found";
    const src = await chrome.tabs.get(${ctx.tabs.X2});
    const list = pages.getPages(src.windowId).filter((p) => p.id === ${ctx.tabs.X2});
    await actions.moveDroppedTabs(${ctx.O}, list, ${ctx.tabs.X2}, -1, list.first().vivExtData?.group ?? undefined);
    return "dropped"; })().catch((e) => "err:" + e)`, ctx.O),
  expect: (s, b, r) => [r === "dropped" ? null : r, tabIs(s, "X2", { win: ctx.O, space: sp("Z") }), recIs(s, ctx.O, sp("Z")), recIs(s, ctx.W, sp("X"))],
});
def("P3.4-move-named", {
  setup: dragSetup(true),
  act: () => h.ev(`chrome.tabs.move(${ctx.tabs.X2}, { windowId: ${ctx.O}, index: -1 }).then(() => "ok", e => "err:" + e)`, ctx.H),
  expect: (s) => [tabIs(s, "X2", { win: ctx.O, space: sp("Z") }), recIs(s, ctx.O, sp("Z")), recIs(s, ctx.W, sp("X"))],
});
def("P3.4-move-default", {
  setup: dragSetup(false),
  act: () => h.ev(`chrome.tabs.move(${ctx.tabs.X2}, { windowId: ${ctx.O}, index: -1 }).then(() => "ok", e => "err:" + e)`, ctx.H),
  expect: (s) => { const t = find(s, ctx.tabs.X2); return [tabIs(s, "X2", { win: ctx.O, space: 0 }), t && t.ws !== null ? `X2's vivExtData keeps workspaceId ${t.ws}, want no key` : null, recIs(s, ctx.O, 0), recIs(s, ctx.W, sp("X"))]; },
});

// "Move to <Space>" in a tab row's right-click menu (Task 8b).
const menuSetup = (other) => async () => {
  await mkWin("W");
  if (other) await mkWin("O");
  await tab(ctx.W, "X1", sp("X")); await tab(ctx.W, "X2", sp("X")); await tab(ctx.W, "X3", sp("X")); await tab(ctx.W, "Y1", sp("Y"));
  await show(ctx.W, sp("X"));
  if (other === "shown") { await tab(ctx.O, "Z1", sp("Z")); await show(ctx.O, sp("Z")); }
  if (other === "parked") { await tab(ctx.O, "Z1", sp("Z")); await tab(ctx.O, "Z2", sp("Z")); await show(ctx.O, sp("Z")); await sleep(300); await show(ctx.O, undefined); await sleep(500); }
  await activate(ctx.tabs.X1); await focus(ctx.W);
};
const menuCase = (id, other, row, target, expect) => def(id, { setup: menuSetup(other), ready: () => waitTile(ctx.W, "X"), act: () => tabMenu(ctx.W, row, `Move to ${target}`), expect });
menuCase("M.inactive", null, "X2", "Y", (s, b, r) => [r.error ?? null, tabIs(s, "X2", { win: ctx.W, space: sp("Y") }), recIs(s, ctx.W, sp("X")), tabIs(s, "X1", { active: true })]);
menuCase("M.active-stays", null, "X1", "Y", (s, b, r) => [r.error ?? null, tabIs(s, "X1", { win: ctx.W, space: sp("Y"), active: false }), recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]);
menuCase("M.shown-elsewhere", "shown", "X2", "Z", (s, b, r) => [r.error ?? null, tabIs(s, "X2", { win: ctx.O, space: sp("Z") }), recIs(s, ctx.O, sp("Z")), recIs(s, ctx.W, sp("X")), tabIs(s, "X1", { active: true })]);
menuCase("M.parked-elsewhere-refused", "parked", "X2", "Z", (s, b, r) => [r.error ?? null, unchanged(b, s),
  /another window/.test(r.toast || "") ? null : `toast ${J(r.toast)}, want "That space is in another window. Show it there first, then move the tab."`]);

// The Dia layout's sidebar button (Task 8c): between Vivaldi's menu button and Back, hides and shows the sidebar.
const ROW = `document.querySelector("#main > .mainbar .toolbar-mainbar")`;
def("D.sidebar-button", {
  layout: "dia",
  setup: async () => { await mkWin("W", { width: 1100 }); await focus(ctx.W); },
  ready: () => waitFor(() => h.ev(`!!document.querySelector("#vm-dia-sidebar")`, ctx.W), 6000),
  act: () => h.ev(`(() => { const row = ${ROW}; const b = document.querySelectorAll("#vm-dia-sidebar");
    return { count: b.length, inRow: !!b[0] && b[0].parentElement === row, prev: b[0]?.previousElementSibling?.matches("button.vivaldi") ?? false,
      next: !!b[0]?.nextElementSibling?.querySelector?.("[data-name='Back']") }; })()`, ctx.W),
  expect: (s, b, r) => [r.count === 1 ? null : `${r.count} buttons, want 1`, r.inRow ? null : "not in the top row", r.prev ? null : "not right after Vivaldi's menu button", r.next ? null : "not right before Back"],
});
const cdpClick = async (win, sel) => {
  const p = await h.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, win);
  if (!p) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await h.cdp(win).send("Input.dispatchMouseEvent", { type, x: p[0], y: p[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  return true;
};
const tabBarShown = (win) => h.ev(`vivaldi.prefs.get("vivaldi.tabs.visible").then((r) => r?.value ?? r)`, win);
def("D.sidebar-toggles", {
  layout: "dia",
  setup: async () => { await mkWin("W", { width: 1100 }); await focus(ctx.W); },
  ready: () => waitFor(() => h.ev(`!!document.querySelector("#vm-dia-sidebar")`, ctx.W), 6000),
  act: async () => {
    const before = await tabBarShown(ctx.W);
    const c1 = await cdpClick(ctx.W, "#vm-dia-sidebar");
    await waitFor(async () => (await tabBarShown(ctx.W)) !== before ? "flipped" : null, 3000);
    const hidden = await tabBarShown(ctx.W);
    const still = await h.ev(`!!document.querySelector("#vm-dia-sidebar")`, ctx.W);
    const c2 = await cdpClick(ctx.W, "#vm-dia-sidebar");
    await waitFor(async () => (await tabBarShown(ctx.W)) === before ? "back" : null, 3000);
    return { before, c1, afterFirst: hidden, buttonWhileHidden: still, c2, afterSecond: await tabBarShown(ctx.W) };
  },
  expect: (s, b, r) => [r.c1 && r.c2 ? null : "button not found to click", r.before === true ? null : `tab bar shown before: ${J(r.before)}`,
    r.afterFirst === false ? null : "the first click did not hide the sidebar", r.buttonWhileHidden ? null : "the button left the row with the sidebar hidden",
    r.afterSecond === true ? null : "the second click did not show the sidebar"],
});
def("D.no-button-in-arc", {
  layout: "arc",
  setup: async () => { await mkWin("W", { width: 1100 }); await focus(ctx.W); await sleep(1500); },
  act: () => h.ev(`document.querySelectorAll("#vm-dia-sidebar").length`, ctx.W),
  expect: (s, b, n) => [n === 0 ? null : `${n} sidebar buttons in the Arc layout`],
});

// Part 3 decisions that are the same check as a row above.
const ALIASES = { "P3.1": ["T.parked-other.click"], "P3.2": ["R.D8", "R.D2"] };

// ---------- running ----------
async function setLayout(dia) {
  await h.refresh();
  await h.ev(`Promise.resolve(window.__vm.settings.set("diaLayout", ${dia})).then(() => true)`, ctx.H);
  await sleep(2500);
  return h.ev(`document.querySelector("#browser").classList.contains("vm-dia")`, ctx.H);
}
const layoutIn = (win) => h.ev(`document.querySelector("#browser")?.classList.contains("vm-dia") ?? null`, win);

async function runCase(c, layout) {
  const t0 = Date.now();
  const out = { id: c.id, layout };
  try {
    if (!(await reset())) out.resetNote = "reset not clean";
    await busy();
    await mkSpaces();
    await c.setup();
    if (ctx.W && (await layoutIn(ctx.W)) !== (layout === "dia")) throw new Error(`W is not in the ${layout} layout`);
    if (c.ready) await c.ready(); else if (ctx.W) await waitTile(ctx.W, "X");
    await busy(); // a fresh 9.5 s for the act
    if (!c.busyThroughAct) await unbusy();
    const before = await h.stable(ctx.H, { quietMs: 1200 });
    const mark = Date.now();
    const result = await c.act();
    if (c.busyThroughAct) await unbusy();
    if (c.gesture) await waitFor(async () => (await busyLeft()) === 0 ? "clear" : null, 12000, 100);
    let heldAtMs = null;
    for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) {
      if (!invariants(await h.snap(ctx.H)).length) { heldAtMs = Date.now() - mark; break; }
    }
    const after = await h.stable(ctx.H, { quietMs: 1500, capMs: 15000 });
    const bad = [...invariants(after).map((v) => `invariant: ${v}`), ...(await c.expect(after, before, result)).filter(Boolean)];
    Object.assign(out, { pass: !bad.length, bad, heldAtMs: c.timed ? heldAtMs : undefined, before: brief(before), after: brief(after), result,
      digestBefore: digest(before), digestAfter: digest(after), ms: Date.now() - t0 });
  } catch (e) {
    Object.assign(out, { pass: false, bad: [`error: ${e.message || e}`], ms: Date.now() - t0 });
  }
  const tag = `${out.pass ? "PASS" : "FAIL"} ${layout} ${c.id}`;
  const timing = out.heldAtMs !== undefined ? ` (invariants held ${out.heldAtMs ?? "never"} ms after the act)` : "";
  console.log(out.pass ? `${tag}${timing}` : `${tag}${timing}: ${out.bad.join(" | ")}\n      before ${out.before ?? "-"}\n      after  ${out.after ?? "-"}`);
  if (LOGDIR) writeFileSync(`${LOGDIR}/${layout}-${c.id}.json`, J(out, null, 1));
  return out;
}

await start();
await startServer();
const layouts = LAYOUT === "both" ? ["dia", "arc"] : [LAYOUT];
const results = [];
for (const layout of layouts) {
  const on = await setLayout(layout === "dia");
  if (on !== (layout === "dia")) { console.log(`FAIL ${layout} layout: could not set it (vm-dia ${on})`); continue; }
  // Arc: the tile rows (gesture table and dots) and the button's absence; Dia: everything that is not Arc-only.
  const set = C.filter((c) => (c.layout ? c.layout === layout : layout === "dia" || c.gesture))
    .filter((c) => !ONLY.length || ONLY.some((p) => c.id.startsWith(p)));
  const mine = [];
  for (const c of set) mine.push(await runCase(c, layout));
  for (const [alias, ids] of Object.entries(ALIASES)) {
    const got = ids.map((id) => mine.find((r) => r.id === id)).filter(Boolean);
    if (got.length !== ids.length) continue;
    const ok = got.every((r) => r.pass);
    console.log(`${ok ? "PASS" : "FAIL"} ${layout} ${alias} (= ${ids.join(" + ")})`);
    mine.push({ id: alias, layout, pass: ok, alias: true });
  }
  results.push(...mine);
  const n = mine.filter((r) => r.pass).length;
  console.log(`${layout}: ${n} pass, ${mine.length - n} fail`);
}
await reset().catch(() => {});
await setLayout(false).catch(() => {});
h.close();
server.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
