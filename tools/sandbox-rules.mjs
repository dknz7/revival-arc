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
import { Harness, Cdp, targets, sleep, tabUrl } from "./sandbox-lib.mjs";

const J = JSON.stringify;
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback; };
const LAYOUT = opt("--layout", "both");
const ONLY = (opt("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const LOGDIR = opt("--log", null);
const SHOTS = opt("--shots", null); // a folder: the sound cases (SND.) save screenshots there
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // /snd-<label>: a page that, once told to (window.play(), from a CDP evaluate with a user gesture), plays a very quiet
    // WebAudio tone; window.stop() ends it. Chrome then reports the tab as audible.
    if (req.url.startsWith("/snd-")) {
      res.end(`<title>SND-${req.url.slice(5)}</title>sound ${req.url}<script>let c, o;
        window.play = async () => { c = new AudioContext(); await c.resume(); o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.002; o.connect(g).connect(c.destination); o.start(); return c.state; };
        window.stop = () => { try { o.stop(); } catch (_) {} return 1; };</script>`);
      return;
    }
    res.end(`<title>page${req.url}</title>page ${req.url}`);
  });
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
  // Task 8n: no test clock, the daily toggle off, nothing cleaned, no daily run recorded (per profile, shared by the windows)
  await h.ev(`(async () => { const c = window.__vm.cleanup; if (c) c.test = null; if (window.__vm.settings.get("cleanupDaily")) window.__vm.settings.set("cleanupDaily", false);
    await window.__vm.store.set("cleaned", []); await window.__vm.store.set("lastCleanup", 0); return 1; })()`, H).catch(() => {});
  ctx.roles = { H }; ctx.tabs = {}; ctx.spaces = {};
  for (const k of ["W", "O", "V", "N"]) delete ctx[k];
  await unbusy(true);
  const clean = s.wins.length === 1 && s.all.length === 0 && s.spaces.length === 0 && s.wins[0].tabs.length === 1;
  return { clean, why: clean ? null : `${s.wins.length} windows, ${s.spaces.length} spaces, record ${J(s.all)}, ${s.wins.map((w) => w.tabs.length).join("+")} tabs` };
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
  gesture: true, clicks: true, busyThroughAct: SPLIT.has(row), setup: SET[row],
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
  gesture: true, clicks: true, setup: SET["shown-here"], act: () => clickTile(ctx.W, "default"),
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
  // W is left recorded on X with no X tab (C3) -> repair 1. X1 arrived in O by chrome.tabs.move, which keeps its space
  // (C1): it stays X, parked in O (O shows the default).
  expect: (s) => [recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), tabIs(s, "X1", { win: ctx.O, space: sp("X") }), recIs(s, ctx.O, 0)],
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

// Decision 4: a tab dragged into another window joins the space it shows. That is Vivaldi's own drop (H2); Vivarc adds
// nothing. A tab moved by other code (chrome.tabs.move) keeps its space (C1) and arrives parked, and repair 3 takes it from there.
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
  timed: true,
  setup: dragSetup(true),
  act: () => h.ev(`chrome.tabs.move(${ctx.tabs.X2}, { windowId: ${ctx.O}, index: -1 }).then(() => "ok", e => "err:" + e)`, ctx.H),
  // X2 keeps X (C1) and arrives parked in O, which splits X across W and O: repair 3 gathers it back where X is shown.
  expect: (s) => [tabIs(s, "X2", { win: ctx.W, space: sp("X") }), tabIs(s, "X1", { win: ctx.W, space: sp("X") }), recIs(s, ctx.O, sp("Z")), recIs(s, ctx.W, sp("X"))],
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
// The sidebar hides per window (Task 8e): a class on this window's #browser, never Vivaldi's profile-wide pref, so the other
// window keeps its sidebar. Hidden = the class and a tab bar column of width 0; the pref must stay true throughout.
const sideState = (win) => h.ev(`(() => { const b = document.querySelector("#browser"); const bar = document.querySelector("#tabs-tabbar-container");
  return { hidden: b.classList.contains("vm-sidebar-hidden"), barW: Math.round(bar.getBoundingClientRect().width), tip: document.querySelector("#vm-dia-sidebar")?.title ?? null,
    pref: undefined }; })()`, win).then(async (st) => ({ ...st, pref: await h.ev(`vivaldi.prefs.get("vivaldi.tabs.visible").then((r) => r?.value ?? r)`, win) }));
// Ctrl+S as the keyboard sends it (Control down, S down and up, Control up) to the window's UI, which is where Vivaldi's
// onKeyboardShortcut hears it; every window hears it, and only the one it was pressed in may act.
const ctrlS = async (win) => {
  await focus(win);
  const c = h.cdp(win), ctrl = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 }, s = { key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 };
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ctrl, modifiers: 2 });
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...s, modifiers: 2 });
  await sleep(60);
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...s, modifiers: 2 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...ctrl, modifiers: 0 });
  await sleep(900);
};
const twoWindows = async () => { await mkWin("W", { width: 1100 }); await mkWin("O", { width: 1100 }); await focus(ctx.W); await sleep(1000); };
const onlyW = (w, o, what) => [w.hidden && w.barW === 0 ? null : `${what}: W not hidden (${J(w)})`, !o.hidden && o.barW > 100 ? null : `${what}: O's sidebar changed (${J(o)})`,
  w.pref === true && o.pref === true ? null : `${what}: Vivaldi's own pref changed (${J([w.pref, o.pref])})`];
def("D.sidebar-toggles", {
  layout: "dia",
  setup: twoWindows,
  ready: () => waitFor(() => h.ev(`!!document.querySelector("#vm-dia-sidebar")`, ctx.W), 6000),
  act: async () => {
    const r = { start: await sideState(ctx.W) };
    r.c1 = await cdpClick(ctx.W, "#vm-dia-sidebar"); await sleep(900);
    r.hiddenW = await sideState(ctx.W); r.hiddenO = await sideState(ctx.O);
    r.buttonWhileHidden = await h.ev(`!!document.querySelector("#vm-dia-sidebar")`, ctx.W);
    r.c2 = await cdpClick(ctx.W, "#vm-dia-sidebar"); await sleep(900);
    r.backW = await sideState(ctx.W); r.backO = await sideState(ctx.O);
    return r;
  },
  expect: (s, b, r) => [r.c1 && r.c2 ? null : "button not found to click", ...onlyW(r.hiddenW, r.hiddenO, "first click"),
    r.hiddenW.tip === "Show sidebar (Ctrl+S)" ? null : `tooltip while hidden: ${J(r.hiddenW.tip)}`, r.hiddenO.tip === "Hide sidebar (Ctrl+S)" ? null : `O's tooltip: ${J(r.hiddenO.tip)}`,
    r.buttonWhileHidden ? null : "the button left the row with the sidebar hidden",
    !r.backW.hidden && r.backW.barW === r.start.barW && !r.backO.hidden ? null : `second click did not show it again (${J(r.backW)})`, r.backW.tip === "Hide sidebar (Ctrl+S)" ? null : `tooltip after: ${J(r.backW.tip)}`],
});
// Ctrl+S in both layouts: hides the window it is pressed in, shows it on a second press, and leaves the other window alone.
for (const layout of ["dia", "arc"]) {
  def(`D.sidebar-key-${layout}`, {
    layout,
    setup: twoWindows,
    act: async () => {
      const r = { start: await sideState(ctx.W) };
      await ctrlS(ctx.W); r.hiddenW = await sideState(ctx.W); r.hiddenO = await sideState(ctx.O);
      await ctrlS(ctx.O); r.bothW = await sideState(ctx.W); r.bothO = await sideState(ctx.O);
      await ctrlS(ctx.W); r.onlyO = await sideState(ctx.O); r.backW = await sideState(ctx.W);
      await ctrlS(ctx.O); r.backO = await sideState(ctx.O);
      return r;
    },
    expect: (s, b, r) => [...onlyW(r.hiddenW, r.hiddenO, "Ctrl+S in W"),
      r.bothW.hidden && r.bothO.hidden && r.bothO.barW === 0 ? null : `Ctrl+S in O while W is hidden: ${J([r.bothW.hidden, r.bothO.hidden])}`,
      !r.backW.hidden && r.backW.barW === r.start.barW && r.onlyO.hidden ? null : `second Ctrl+S in W: ${J([r.backW, r.onlyO.hidden])}`,
      !r.backO.hidden && r.backO.barW === r.start.barW ? null : "second Ctrl+S in O did not show it"],
  });
}
// The window buttons (minimise, maximise, close) are not in the tab bar (measured: in Dia on the top row, in Arc with Vivaldi's own
// frame in the auto-hiding #titlebar), so hiding the sidebar must not move or hide them.
for (const layout of ["dia", "arc"]) {
  def(`D.sidebar-hide-keeps-window-buttons-${layout}`, {
    layout,
    setup: twoWindows,
    act: async () => {
      const read = () => h.ev(`[...document.querySelectorAll(".window-buttongroup")].map((g) => { const r = g.getBoundingClientRect(); return [g.className.includes("on-mainbar"), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), getComputedStyle(g).display]; })`, ctx.W);
      const before = await read();
      await ctrlS(ctx.W);
      const hidden = (await sideState(ctx.W)).hidden;
      const during = await read();
      await ctrlS(ctx.W);
      return { before, during, hidden };
    },
    expect: (s, b, r) => [r.hidden ? null : "the sidebar did not hide", JSON.stringify(r.before) === JSON.stringify(r.during) ? null : `window buttons moved: ${J(r.before)} -> ${J(r.during)}`,
      r.during.every((g) => g[5] !== "none") ? null : "window buttons hidden"],
  });
}
def("D.no-button-in-arc", {
  layout: "arc",
  setup: async () => { await mkWin("W", { width: 1100 }); await focus(ctx.W); await sleep(1500); },
  act: () => h.ev(`document.querySelectorAll("#vm-dia-sidebar").length`, ctx.W),
  expect: (s, b, n) => [n === 0 ? null : `${n} sidebar buttons in the Arc layout`],
});

// Task 8f: a tab row dragged out of the sidebar past the window opens in a new window, as a plain tab of that window's
// default space. The drag is a real HTML5 one driven through CDP (Input.setInterceptDrags + dispatchMouseEvent, then
// dispatchDragEvent to end it at x,y): dragstart and dragend are the browser's own events, but the drop point is not an
// OS cursor. Measured: dragend's screenX/screenY equal the x,y given (the window's origin is not added), so an
// "outside" point is one beyond the window's screen rect, an "inside" one within it.
async function dragRow(win, finder, to) {
  const rect = await waitFor(() => h.ev(`(() => { const r = ${finder}; if (!r) return null; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return r.contains(top) ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`, win), 8000);
  if (!rect) return "no row to drag";
  const c = h.cdp(win);
  await c.send("Input.setInterceptDrags", { enabled: true });
  try {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + i * 4, y: rect.y + i * 3, button: "left", buttons: 1 }); await sleep(60); }
    await sleep(400);
    const data = { items: [], dragOperationsMask: 1 };
    await c.send("Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data });
    await c.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
  } finally { await c.send("Input.setInterceptDrags", { enabled: false }).catch(() => {}); }
  return "dropped";
}
const tabRowOf = (label) => `[...document.querySelectorAll("#vm-panel .vm-tab")].find((r) => r.textContent.includes(${J(label)}))`;
const OUT = { x: 2400, y: 300 }, IN = { x: 300, y: 420 };
const tearCase = (id, { setup, label, to = OUT, find, expect, after }) => def(id, {
  gesture: true, setup, ready: () => waitFor(() => h.ev(`!!(${find ?? tabRowOf(label)})`, ctx.W), 8000),
  act: async () => { const r = await dragRow(ctx.W, find ?? tabRowOf(label), to); return r === "dropped" && after ? after() : r; }, expect,
});
const strangers = (s) => normal(s).filter((w) => !["H", "W", "O", "V"].some((r) => ctx.roles[r] === w.id)).map((w) => w.id);
const noNewWindow = (s) => strangers(s).length ? "a new window is open" : null;
// After a tear-off: the new window's toast (it must reach that window, which is the focused one) and, if asked, its Undo.
const tornWindow = async () => {
  const n = await waitFor(async () => { await h.refresh(); return newWindow(await h.snap(ctx.H)); }, 8000);
  if (n) await h.waitForWin(n);
  return n;
};
const toastIn = (n) => waitFor(() => h.ev(`document.querySelector("#vm-copied")?.textContent || null`, n), 6000, 100);
const seesToast = async () => { const n = await tornWindow(); ctx.toast = n ? await toastIn(n) : null; return "dropped"; };
const clicksUndo = async () => {
  const n = await tornWindow();
  if (!n) return "no new window";
  const ok = await waitFor(() => h.ev(`(() => { const b = document.querySelector("#vm-copied .vm-toast-action"); if (!b) return false; b.click(); return true; })()`, n), 6000, 100);
  return ok ? "clicked" : "no Undo button on the toast";
};
const extOf = (id) => h.ev(`chrome.tabs.get(${id}).then((t) => JSON.parse(t.vivExtData || "{}"))`, ctx.H).catch(() => null);
tearCase("D.tear-off", {
  setup: SET["shown-here"], label: "X2", after: seesToast,
  expect: (s, b) => { const n = strangers(s)[0] ?? null; return [n == null ? "no new window" : null, n != null ? tabIs(s, "X2", { win: n, space: 0 }) : null,
    n != null ? recIs(s, n, 0) : null, tabIs(s, "X1", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X")),
    n != null && normal(s).find((w) => w.id === n).tabs.length === 1 ? null : "the new window should hold just the torn-off tab",
    /Opened in a new window/.test(ctx.toast || "") ? null : `toast in the new window ${J(ctx.toast)}, want "Opened in a new window" + Undo`]; },
});
// Undo: the tab goes back to its place in the source window, in its space; the emptied new window closes.
tearCase("D.tear-off-undo", {
  setup: SET["shown-here"], label: "X2", after: clicksUndo,
  expect: (s, b) => [noNewWindow(s), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), tabIs(s, "X1", { win: ctx.W, space: sp("X"), active: true }),
    find(s, ctx.tabs.X2)?.index === find(b, ctx.tabs.X2)?.index ? null : `X2 index ${find(s, ctx.tabs.X2)?.index}, was ${find(b, ctx.tabs.X2)?.index}`,
    recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))],
});
tearCase("D.tear-off-undo-active", {
  setup: SET["shown-here"], label: "X1", after: clicksUndo,
  expect: (s, b) => [noNewWindow(s), tabIs(s, "X1", { win: ctx.W, space: sp("X"), active: true }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }),
    find(s, ctx.tabs.X1)?.index === find(b, ctx.tabs.X1)?.index ? null : `X1 index ${find(s, ctx.tabs.X1)?.index}, was ${find(b, ctx.tabs.X1)?.index}`,
    recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))],
});
tearCase("D.tear-off-undo-default", {
  setup: async () => { await mkWin("W"); await tab(ctx.W, "D2", 0); await focus(ctx.W); }, label: "D2", after: clicksUndo,
  expect: (s, b) => [noNewWindow(s), tabIs(s, "D2", { win: ctx.W, space: 0 }), recIs(s, ctx.W, 0)],
});
// A tab in a split view leaves it, and its peers here leave it too (Close Split View's way).
tearCase("D.tear-off-split", {
  setup: async () => {
    await SET["shown-here"]();
    const t = { id: "sbx-split", layout: "row", type: "selection" };
    for (const [i, label] of ["X1", "X2"].entries()) {
      const cur = await extOf(ctx.tabs[label]);
      await h.ev(`chrome.tabs.update(${ctx.tabs[label]}, { vivExtData: ${J(J({ ...cur, tiling: { ...t, index: i } }))} }).then(() => 1)`, ctx.H);
    }
    await sleep(600);
    if (!(await extOf(ctx.tabs.X2))?.tiling || !(await extOf(ctx.tabs.X1))?.tiling) throw new Error("the split view was not recorded on X1 and X2");
  }, label: "X2",
  expect: async (s) => { const n = newWindow(s), x1 = await extOf(ctx.tabs.X1), x2 = await extOf(ctx.tabs.X2); return [n == null ? "no new window" : null,
    n != null ? tabIs(s, "X2", { win: n, space: 0 }) : null, x2?.tiling ? `X2 keeps tiling ${J(x2.tiling)}` : null, x1?.tiling ? `X1 (peer) keeps tiling ${J(x1.tiling)}` : null,
    tabIs(s, "X1", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X"))]; },
});
tearCase("D.tear-off-active", {
  setup: SET["shown-here"], label: "X1",
  expect: (s) => { const n = newWindow(s); return [n == null ? "no new window" : null, n != null ? tabIs(s, "X1", { win: n, space: 0 }) : null,
    n != null ? recIs(s, n, 0) : null, tabIs(s, "X2", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]; },
});
tearCase("D.tear-off-last-of-space", {
  setup: async () => { await mkWin("W"); await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W); }, label: "X1",
  // X's only tab leaves: W is recorded on a space with no tab, and repair 1 switches it to its default (C3/D1)
  expect: (s) => { const n = newWindow(s); return [n == null ? "no new window" : null, n != null ? tabIs(s, "X1", { win: n, space: 0 }) : null,
    n != null ? recIs(s, n, 0) : null, recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), inSpace(s, sp("X")).length ? "X still has tabs" : null]; },
});
tearCase("D.tear-off-default-tab", {
  setup: async () => { await mkWin("W"); await tab(ctx.W, "D2", 0); await focus(ctx.W); }, label: "D2",
  expect: (s) => { const n = newWindow(s); return [n == null ? "no new window" : null, n != null ? tabIs(s, "D2", { win: n, space: 0 }) : null, recIs(s, ctx.W, 0)]; },
});
tearCase("D.tear-off-stays-inside", {
  setup: SET["shown-here"], label: "X2", to: IN,
  expect: (s, b) => [noNewWindow(s), unchanged(b, s)],
});
tearCase("D.tear-off-only-tab", {
  setup: async () => { await mkWin("W"); await focus(ctx.W); }, label: "W-d0",
  expect: (s, b) => [noNewWindow(s), unchanged(b, s)],
});
tearCase("D.tear-off-favorite-stays", {
  setup: async () => {
    await mkWin("W", { width: 1000 }); await tab(ctx.W, "X1", sp("X")); await focus(ctx.W);
    ctx.title = "TEARFAV"; await bookmark(await favoritesFolder(), ctx.title, `${origin}/tearfav-${Date.now()}`);
  },
  find: `[...document.querySelectorAll("#vm-panel .vm-fav")].find((t) => t.title === "TEARFAV")`,
  expect: (s, b) => [noNewWindow(s), unchanged(b, s)],
});

// Task 8g: a tab row dragged from W's sidebar into O's sidebar. CDP cannot carry a drag between two windows by itself, so
// the parts are: REAL: W's dragstart (a browser-driven HTML5 drag through setInterceptDrags + mouse events), the data it
// writes (the custom type is read back from the intercepted drag data), and the dragover and
// drop O's own page receives (Input.dispatchDragEvent on O's target with W's exact data, so O's handler reads the type with
// getData); and Vivaldi's tab move. SYNTHETIC: the hand-over between the two windows (the OS would do it), and W's dragend,
// which is ended by a drop at OUT (outside W): that gives the worst case for the interplay, a source reporting
// dropEffect "none" beyond its edge after another window took the tab. What a real source reports then is Byron's check.
async function dragAcross(src, srcFinder, dst, dstFinder, { frac = 0.25, finishAt = OUT, settleMs = 1500, race = false } = {}) {
  const grab = (win, finder, f) => waitFor(() => h.ev(`(() => { const r = ${finder}; if (!r) return null; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); const x = b.left + b.width / 2;
    const top = document.elementFromPoint(x, b.top + b.height / 2); return r.contains(top) ? { x, y: b.top + b.height * ${f} } : null; })()`, win), 8000);
  const from = await grab(src, srcFinder, 0.5), to = await grab(dst, dstFinder, frac);
  if (!from) return "no row to drag";
  if (!to) return "no row to drop on";
  const cs = h.cdp(src), cd = h.cdp(dst);
  let data = null;
  const onMsg = (m) => { const d = JSON.parse(m.data); if (d.method === "Input.dragIntercepted") data = d.params.data; };
  cs.ws.addEventListener("message", onMsg);
  await cs.send("Input.setInterceptDrags", { enabled: true });
  try {
    await cs.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await cs.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + i * 4, y: from.y + i * 3, button: "left", buttons: 1 }); await sleep(60); }
    await sleep(500);
    if (!data) return "the drag never started";
    ctx.dragData = data;
    // keep what the two sidebars warn while the drop runs, so a failure can say why
    const hook = `(window.__w8g = [], console.warn = ((o) => (...a) => { window.__w8g.push(a.map(String).join(" ").slice(0, 200)); o.apply(console, a); })(console.warn), 1)`;
    await h.ev(hook, dst).catch(() => {}); if (dst !== src) await h.ev(hook, src).catch(() => {});
    const finish = async () => {
      const none = { items: [], dragOperationsMask: 1 };
      await cs.send("Input.dispatchDragEvent", { type: "dragEnter", x: finishAt.x, y: finishAt.y, data: none });
      await cs.send("Input.dispatchDragEvent", { type: "drop", x: finishAt.x, y: finishAt.y, data: none });
    };
    const at = (await grab(dst, dstFinder, frac)) ?? to; // the row may have moved since it was first measured: aim at where it is now
    for (const type of ["dragEnter", "dragOver"]) { await cd.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }); await sleep(150); }
    // race: the target's drop and the source's dragend are sent in the same instant (no wait between them)
    const drop = cd.send("Input.dispatchDragEvent", { type: "drop", x: at.x, y: at.y, data });
    if (race && finishAt) await Promise.all([drop, finish()]); else await drop;
    await sleep(settleMs);
    if (finishAt && !race) await finish();
    await sleep(600);
    ctx.warns = { dst: await h.ev(`window.__w8g`, dst).catch(() => null), src: dst !== src ? await h.ev(`window.__w8g`, src).catch(() => null) : null };
    await cs.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: from.y, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
  } finally { cs.ws.removeEventListener("message", onMsg); await cs.send("Input.setInterceptDrags", { enabled: false }).catch(() => {}); }
  return "dropped";
}
// Runs the act while counting normal windows every ~30 ms, then a while after it (a tear-off that wrongly fires comes
// ~250 ms later): the most seen is kept in ctx.maxWins, so a window that flashes open and is gone again is still caught.
// H, W and O are the three expected.
async function sampled(act) {
  ctx.maxWins = 0;
  let stop = false;
  const watcher = (async () => { while (!stop) { const n = await h.ev(`chrome.windows.getAll({ windowTypes: ["normal"] }).then((w) => w.length)`, ctx.H).catch(() => 0); ctx.maxWins = Math.max(ctx.maxWins, n); await sleep(30); } })();
  try { return await act(); } finally { await sleep(1500); stop = true; await watcher; }
}
const SET_ACROSS = async () => {
  await mkWin("W", { width: 1000 }); await mkWin("O", { width: 1000 });
  await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
  await tab(ctx.O, "Y1", sp("Y"), { active: true }); await tab(ctx.O, "Y2", sp("Y")); await tab(ctx.O, "Y3", sp("Y")); await show(ctx.O, sp("Y")); await activate(ctx.tabs.Y1);
  await focus(ctx.W);
};
const acrossCase = (id, { label = "X2", onto = "Y2", ontoFinder, frac, setup = SET_ACROSS, ready, finishAt, settleMs, race, expect }) => def(id, {
  gesture: true, setup, ready: ready ?? (async () => (await waitFor(() => h.ev(`!!(${tabRowOf(label)})`, ctx.W), 8000)) && (await waitFor(() => h.ev(`!!(${ontoFinder ?? tabRowOf(onto)})`, ctx.O), 8000))),
  act: () => sampled(() => dragAcross(ctx.W, tabRowOf(label), ctx.O, ontoFinder ?? tabRowOf(onto), { frac, finishAt, settleMs, race })), expect,
});
const noStranger = (s) => strangers(s).length ? `a new window was opened (warnings: ${J(ctx.warns)})` : ctx.maxWins > 3 ? `a window flashed open during the drop (${ctx.maxWins} normal windows seen, 3 expected)` : null;
const shownStill = (s) => [recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X")), recIs(s, ctx.O, sp("Y")), showsSpace(s, ctx.O, sp("Y"))];
// Above Y2's middle: X2 lands directly above Y2 in O (the list shows the highest index first, so one index higher), in
// O's shown space Y, active there; W keeps X and its X1; no new window. W's dragend (none, outside) did not tear it off.
acrossCase("D.drag-across", {
  frac: 0.25,
  expect: (s, b) => [tabIs(s, "X2", { win: ctx.O, space: sp("Y"), active: true }), tabIs(s, "X1", { win: ctx.W, space: sp("X") }),
    find(s, ctx.tabs.X2)?.index === (find(b, ctx.tabs.Y2)?.index ?? -9) + 1 ? null : `X2 index ${find(s, ctx.tabs.X2)?.index}, want Y2's old ${find(b, ctx.tabs.Y2)?.index} + 1`,
    find(s, ctx.tabs.Y2)?.index === find(b, ctx.tabs.Y2)?.index ? null : `Y2 moved: ${find(b, ctx.tabs.Y2)?.index} -> ${find(s, ctx.tabs.Y2)?.index}`,
    ...shownStill(s), noStranger(s)],
});
// The worst case for the interplay: W's dragend (none, outside) is sent in the same instant as O's drop, so it can win against O's move; windows are counted throughout (a tear-off that wrongly fires shows as a 4th).
acrossCase("D.drag-across-source-dragend-at-once", {
  frac: 0.25, settleMs: 0, race: true,
  expect: (s) => [tabIs(s, "X2", { win: ctx.O, space: sp("Y"), active: true }), tabIs(s, "X1", { win: ctx.W, space: sp("X") }), ...shownStill(s), noStranger(s)],
});
// Below Y2's middle: directly below it, at Y2's old index (Y2 is pushed up one).
acrossCase("D.drag-across-below", {
  frac: 0.75,
  expect: (s, b) => [tabIs(s, "X2", { win: ctx.O, space: sp("Y"), active: true }),
    find(s, ctx.tabs.X2)?.index === find(b, ctx.tabs.Y2)?.index ? null : `X2 index ${find(s, ctx.tabs.X2)?.index}, want Y2's old ${find(b, ctx.tabs.Y2)?.index}`,
    find(s, ctx.tabs.Y2)?.index === (find(b, ctx.tabs.Y2)?.index ?? -9) + 1 ? null : `Y2 index ${find(s, ctx.tabs.Y2)?.index}, want old + 1`,
    ...shownStill(s), noStranger(s)],
});
// The row's middle makes no folder across windows: the nearer edge decides (0.45 is above the middle).
acrossCase("D.drag-across-middle-no-folder", {
  frac: 0.45,
  expect: async (s, b) => { const x = await extOf(ctx.tabs.X2); return [tabIs(s, "X2", { win: ctx.O, space: sp("Y"), active: true }),
    find(s, ctx.tabs.X2)?.index === (find(b, ctx.tabs.Y2)?.index ?? -9) + 1 ? null : `X2 index ${find(s, ctx.tabs.X2)?.index}, want above Y2`,
    x?.group ? `X2 joined a folder ${J(x.group)}` : null, ...shownStill(s), noStranger(s)]; },
});
// The tab that was W's active one: W falls back to another tab of its space (X1 here) and keeps showing X.
acrossCase("D.drag-across-active", {
  label: "X1",
  expect: (s) => [tabIs(s, "X1", { win: ctx.O, space: sp("Y"), active: true }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), ...shownStill(s), noStranger(s)],
});
// The last tab of its space in W: W's record is on a space with no tab, and repair 1 puts it on default.
acrossCase("D.drag-across-last-of-space", {
  setup: async () => {
    await mkWin("W", { width: 1000 }); await mkWin("O", { width: 1000 });
    await tab(ctx.W, "X1", sp("X"), { active: true }); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
    await tab(ctx.O, "Y1", sp("Y"), { active: true }); await tab(ctx.O, "Y2", sp("Y")); await show(ctx.O, sp("Y")); await activate(ctx.tabs.Y1); await focus(ctx.W);
  }, label: "X1",
  expect: (s) => [tabIs(s, "X1", { win: ctx.O, space: sp("Y"), active: true }), recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0), recIs(s, ctx.O, sp("Y")), noStranger(s),
    inSpace(s, sp("X")).length ? "X still has tabs" : null],
});
// A default-space tab dropped on a named space's window joins that space.
acrossCase("D.drag-across-default-tab", {
  setup: async () => {
    await mkWin("W", { width: 1000 }); await mkWin("O", { width: 1000 }); await tab(ctx.W, "D2", 0);
    await tab(ctx.O, "Y1", sp("Y"), { active: true }); await tab(ctx.O, "Y2", sp("Y")); await show(ctx.O, sp("Y")); await activate(ctx.tabs.Y1); await focus(ctx.W);
  }, label: "D2",
  expect: (s) => [tabIs(s, "D2", { win: ctx.O, space: sp("Y"), active: true }), recIs(s, ctx.W, 0), recIs(s, ctx.O, sp("Y")), noStranger(s)],
});
// Into a window on its default space the tab becomes a default tab.
acrossCase("D.drag-across-into-default", {
  setup: async () => {
    await mkWin("W", { width: 1000 }); await mkWin("O", { width: 1000 });
    await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
    await tab(ctx.O, "D2", 0); await focus(ctx.W);
  }, label: "X2", onto: "D2",
  expect: (s) => [tabIs(s, "X2", { win: ctx.O, space: 0, active: true }), tabIs(s, "X1", { win: ctx.W, space: sp("X") }), recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, 0), noStranger(s)],
});
// A tab in a split view leaves it, and its peer in W leaves it too.
acrossCase("D.drag-across-split", {
  setup: async () => {
    await SET_ACROSS();
    const t = { id: "sbx-split", layout: "row", type: "selection" };
    for (const [i, label] of ["X1", "X2"].entries()) {
      const cur = await extOf(ctx.tabs[label]);
      await h.ev(`chrome.tabs.update(${ctx.tabs[label]}, { vivExtData: ${J(J({ ...cur, tiling: { ...t, index: i } }))} }).then(() => 1)`, ctx.H);
    }
    await sleep(600);
    if (!(await extOf(ctx.tabs.X2))?.tiling || !(await extOf(ctx.tabs.X1))?.tiling) throw new Error("the split view was not recorded on X1 and X2");
  },
  expect: async (s) => { const x1 = await extOf(ctx.tabs.X1), x2 = await extOf(ctx.tabs.X2); return [tabIs(s, "X2", { win: ctx.O, space: sp("Y") }),
    x2?.tiling ? `X2 keeps tiling ${J(x2.tiling)}` : null, x1?.tiling ? `X1 (peer) keeps tiling ${J(x1.tiling)}` : null, noStranger(s)]; },
});
// Dropping on the New Tab row (the top of the list) puts the tab last in the window: the way in for a space with no rows.
acrossCase("D.drag-across-new-tab-row", {
  ontoFinder: `document.querySelector("#vm-panel .vm-newtab")`, frac: 0.5,
  expect: (s, b) => [tabIs(s, "X2", { win: ctx.O, space: sp("Y"), active: true }),
    find(s, ctx.tabs.X2)?.index === normal(s).find((w) => w.id === ctx.O).tabs.length - 1 ? null : `X2 is not the window's last tab (index ${find(s, ctx.tabs.X2)?.index})`,
    ...shownStill(s), noStranger(s)],
});
// The same-window drag still reorders as before (the custom type is ignored when the source is this window).
def("D.drag-across-same-window-unchanged", {
  gesture: true, setup: SET_ACROSS, ready: () => waitFor(() => h.ev(`!!(${tabRowOf("X2")}) && !!(${tabRowOf("X1")})`, ctx.W), 8000),
  act: () => sampled(() => dragAcross(ctx.W, tabRowOf("X1"), ctx.W, tabRowOf("X2"), { frac: 0.25, finishAt: null })),
  expect: (s, b) => [tabIs(s, "X1", { win: ctx.W, space: sp("X") }), tabIs(s, "X2", { win: ctx.W, space: sp("X") }), noStranger(s),
    find(s, ctx.tabs.X1)?.index > find(s, ctx.tabs.X2)?.index ? null : "X1 did not move above X2 (the in-window drop did not run)"],
});

// ---------- Task 8k: the New Tab row's dropdown, driven with real mouse events ----------
// The chevron, the menu rows and the flyouts are clicked with CDP mouse events (hover included), as a user would; what a
// row does is then read from the browser's own state. All run in both layouts. NT_MENU is the menu without its flyouts.
const NT_MENU = ".vm-menu:not(.vm-menu-flyout)";
const NT_ROW = `document.querySelector("#vm-panel .vm-newtab")`;
const NT_CHEV = `document.querySelector("#vm-panel .vm-newtab-chev")`;
const NT_LABELS = ["Search Tabs…", "Open Tabs", "Recently Closed", "Recently Closed Windows", "Recently Cleaned", "---", "Clean Up Tabs", "Clean Up Daily", "---", "Mute All Tabs", "Close All Tabs"];
const mouse = (win, type, x, y) => h.cdp(win).send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
const centre = (win, expr) => h.ev(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return b.width && b.height ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`, win);
const hoverOn = async (win, expr) => { const p = await waitFor(() => centre(win, expr), 6000); if (!p) return false; await mouse(win, "mouseMoved", p.x, p.y); return p; };
const clickOn = async (win, expr) => { const p = await hoverOn(win, expr); if (!p) return false; await mouse(win, "mousePressed", p.x, p.y); await mouse(win, "mouseReleased", p.x, p.y); return true; };
const labelOfRow = `((n.querySelector(".vm-menu-label") || n).textContent.trim())`;
const menuRow = (label) => `[...document.querySelectorAll(${J(NT_MENU + " .vm-menu-item")})].find((n) => ${labelOfRow} === ${J(label)})`;
const flyRow = (label) => `[...document.querySelectorAll(".vm-menu-flyout .vm-menu-item")].find((n) => ${labelOfRow} === ${J(label)})`;
const rowsOf = (win, sel) => h.ev(`[...document.querySelectorAll(${J(sel)})].map((d) => d.className.includes("sep") ? "---" : d.className.includes("heading") ? "# " + d.textContent : (d.querySelector(".vm-menu-label") || d).textContent.trim() + (d.className.includes("marked") ? " *" : "") + (d.className.includes("disabled") ? " (disabled)" : ""))`, win);
const hasEl = (win, sel) => h.ev(`!!document.querySelector(${J(sel)})`, win);
const escapeAll = (win) => h.ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`, win);
// Hover the row (the chevron shows), click the chevron, wait for the menu.
async function openDropdown(win) {
  await mouse(win, "mouseMoved", 600, 500); await sleep(150);
  if (!(await hoverOn(win, NT_ROW))) return false;
  await sleep(250);
  if (!(await clickOn(win, NT_CHEV))) return false;
  return !!(await waitFor(() => hasEl(win, NT_MENU), 4000));
}
const openFly = async (win, label) => { if (!(await hoverOn(win, menuRow(label)))) return false; return !!(await waitFor(() => hasEl(win, ".vm-menu-flyout"), 4000)); };
// Open the dropdown, open the flyout of `parent`, click its row `row`.
async function pickFrom(win, parent, row) {
  if (!(await openDropdown(win))) return "no dropdown";
  if (!(await openFly(win, parent))) return `no ${parent} flyout`;
  if (!(await clickOn(win, flyRow(row)))) return `no row ${row} in ${parent}: ${J(await rowsOf(win, ".vm-menu-flyout > div"))}`;
  // a tab the pick just made is read by its title: let every tab finish loading before the snapshot (a title is empty until then)
  await sleep(600);
  await waitFor(() => h.ev(`chrome.tabs.query({ windowType: "normal" }).then((t) => t.every((x) => x.status === "complete"))`, ctx.H), 8000, 200);
  return "ok";
}
async function dropdownItem(win, label) {
  if (!(await openDropdown(win))) return "no dropdown";
  if (!(await clickOn(win, menuRow(label)))) return `no menu item ${label}: ${J(await rowsOf(win, NT_MENU + " > div"))}`;
  return "ok";
}
const SET_NT = async () => {
  await mkWin("W", { width: 900 }); await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await tab(ctx.W, "Y1", sp("Y"));
  await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W);
};
const ntCase = (id, c) => def(id, { gesture: true, ready: async () => (await waitFor(() => hasEl(ctx.W, "#vm-panel .vm-newtab-chev"), 8000)) && (await waitTile(ctx.W, "X")), setup: SET_NT, ...c });
const byTitle = (s, title) => normal(s).flatMap((w) => w.tabs.map((t) => ({ ...t, win: w.id, space: t.ws ?? 0 }))).find((t) => t.title === title);

// The chevron shows on hover, sits at the row's right edge, the label stays centred, and its click opens the menu (not the bar).
ntCase("N.chevron-and-menu", {
  act: async () => {
    await mouse(ctx.W, "mouseMoved", 600, 500); await sleep(300);
    const idle = await h.ev(`Number(getComputedStyle(${NT_CHEV}).opacity)`, ctx.W);
    await hoverOn(ctx.W, NT_ROW); await sleep(350);
    const hovered = await h.ev(`Number(getComputedStyle(${NT_CHEV}).opacity)`, ctx.W);
    const geo = await h.ev(`(() => { const r = ${NT_ROW}.getBoundingClientRect(), c = ${NT_CHEV}.getBoundingClientRect(), t = ${NT_ROW}.querySelector(".vm-title").getBoundingClientRect(), p = ${NT_ROW}.querySelector(".vm-plus").getBoundingClientRect();
      return { rowRight: r.right, chevRight: c.right, chevLeft: c.left, titleMid: (p.left + t.right) / 2, rowMid: r.left + r.width / 2 }; })()`, ctx.W);
    await sleep(100);
    if (!(await clickOn(ctx.W, NT_CHEV))) return { error: "no chevron" };
    const open = await waitFor(() => hasEl(ctx.W, NT_MENU), 4000);
    const labels = await rowsOf(ctx.W, NT_MENU + " > div");
    const bar = await hasEl(ctx.W, "#vm-cmd");
    // Recently Cleaned is disabled while nothing was cleaned: hovering it opens nothing.
    await hoverOn(ctx.W, menuRow("Recently Cleaned")); await sleep(500);
    const cleanedFly = await hasEl(ctx.W, ".vm-menu-flyout");
    // A second click on the chevron closes the menu.
    await clickOn(ctx.W, NT_CHEV); await sleep(300);
    const closed = !(await hasEl(ctx.W, ".vm-menu"));
    return { idle, hovered, geo, open, labels, bar, cleanedFly, closed };
  },
  expect: (s, b, r) => [!r?.open ? "the menu did not open" : null, r.idle !== 0 ? `the chevron shows without hover (opacity ${r.idle})` : null, r.hovered !== 1 ? `the chevron is not shown on hover (opacity ${r.hovered})` : null,
    r.geo.chevRight > r.geo.rowRight || r.geo.chevRight < r.geo.rowRight - 12 ? `the chevron is not at the row's right edge (${J(r.geo)})` : null,
    Math.abs(r.geo.titleMid - r.geo.rowMid) > 2 ? `the + New Tab label is not centred (${J(r.geo)})` : null,
    J(r.labels.map((l) => l.replace(" (disabled)", ""))) === J(NT_LABELS) ? null : `menu rows ${J(r.labels)}`,
    r.labels[4] === "Recently Cleaned (disabled)" ? null : `Recently Cleaned is not disabled: ${r.labels[4]}`,
    r.cleanedFly ? "the disabled Recently Cleaned opened a flyout" : null, r.bar ? "the chevron click opened the command bar" : null, r.closed ? null : "a second chevron click did not close the menu", unchanged(b, s)],
});
// The rest of the row keeps its click: the command bar opens, no menu.
ntCase("N.row-click-opens-bar", {
  act: async () => {
    const r = await h.ev(`(() => { const b = ${NT_ROW}.getBoundingClientRect(); return { l: b.left, y: b.top + b.height / 2 }; })()`, ctx.W);
    await mouse(ctx.W, "mouseMoved", r.l + 30, r.y); await sleep(200); await mouse(ctx.W, "mousePressed", r.l + 30, r.y); await mouse(ctx.W, "mouseReleased", r.l + 30, r.y);
    const bar = await waitFor(() => hasEl(ctx.W, "#vm-cmd"), 4000);
    const menu = await hasEl(ctx.W, ".vm-menu");
    await escapeAll(ctx.W); await h.ev(`document.querySelector("#vm-cmd input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) ?? 1`, ctx.W);
    return { bar, menu };
  },
  expect: (s, b, r) => [r.bar ? null : "a click on the row (not the chevron) did not open the command bar", r.menu ? "it opened the menu too" : null, unchanged(b, s)],
});
// Search Tabs… opens the command bar, listing open tabs.
ntCase("N.search-tabs", {
  act: async () => {
    const r = await dropdownItem(ctx.W, "Search Tabs…"); if (r !== "ok") return r;
    const bar = await waitFor(() => hasEl(ctx.W, "#vm-cmd"), 4000);
    const rows = await waitFor(() => h.ev(`[...document.querySelectorAll("#vm-cmd .vm-cmd-row .vm-cmd-title")].map((n) => n.textContent)`, ctx.W).then((x) => (x.length ? x : null)), 4000);
    const menu = await hasEl(ctx.W, ".vm-menu");
    await h.ev(`document.querySelector("#vm-cmd input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) ?? 1`, ctx.W);
    return { bar, rows, menu };
  },
  expect: (s, b, r) => [r.bar ? null : "the command bar did not open", r.menu ? "the menu stayed open" : null, r.rows?.includes("X2") ? null : `the bar does not list the open tabs (${J(r.rows)})`, unchanged(b, s)],
});
// Open Tabs: grouped by window then space, headings, this window's active tab marked, height capped, other windows listed.
ntCase("N.open-tabs-list", {
  setup: async () => { await SET_NT(); await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z"), { active: true }); await show(ctx.O, sp("Z")); await activate(ctx.tabs.Z1); await focus(ctx.W); },
  act: async () => {
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    if (!(await openFly(ctx.W, "Open Tabs"))) return { error: "no Open Tabs flyout" };
    const rows = await rowsOf(ctx.W, ".vm-menu-flyout > div");
    const box = await h.ev(`(() => { const f = document.querySelector(".vm-menu-flyout"), m = document.querySelector(${J(NT_MENU)}), b = f.getBoundingClientRect(), a = m.getBoundingClientRect();
      return { maxH: getComputedStyle(f).maxHeight, overflowY: getComputedStyle(f).overflowY, right: b.right, left: b.left, menuRight: a.right, vw: innerWidth, height: b.height, favicons: f.querySelectorAll(".vm-ico").length }; })()`, ctx.W);
    await escapeAll(ctx.W);
    return { rows, box, menuGone: !(await hasEl(ctx.W, ".vm-menu")) };
  },
  expect: (s, b, r) => {
    const i = (l) => r.rows.indexOf(l);
    const order = ["# This window · X", "X1 *", "X2", "# This window · Y", "Y1"].map(i);
    return [order.some((x) => x < 0) || order.some((x, k) => k && x <= order[k - 1]) ? `This window's groups are missing or out of order: ${J(r.rows)}` : null,
      r.rows.filter((x) => x.endsWith(" *")).length === 1 ? null : `want exactly one active tab marked: ${J(r.rows)}`,
      r.rows.some((x) => /^# Window \d+ · Z$/.test(x)) && r.rows.includes("Z1") ? null : `the other window's Z group is missing: ${J(r.rows)}`,
      i("# This window · X") < r.rows.findIndex((x) => /^# Window \d+/.test(x)) ? null : "this window does not come first",
      r.box.favicons >= 4 ? null : `row icons ${r.box.favicons}`, parseFloat(r.box.maxH) <= 420 && r.box.overflowY === "auto" ? null : `height not capped: ${r.box.maxH} ${r.box.overflowY}`,
      r.box.left >= r.box.menuRight - 8 ? null : `flyout not beside the menu: ${J(r.box)}`, r.menuGone ? null : "Escape did not close the menu and flyout", unchanged(b, s)];
  },
});
// Picking a tab parked in this window's other space shows that space (repair 2 must not snap it back).
ntCase("N.open-tabs-pick-parked", {
  act: () => pickFrom(ctx.W, "Open Tabs", "Y1"),
  expect: (s) => [tabIs(s, "Y1", { win: ctx.W, space: sp("Y"), active: true }), recIs(s, ctx.W, sp("Y")), showsSpace(s, ctx.W, sp("Y"))],
});
// Picking a tab in another window that shows its space: that window comes to the front with the tab active.
ntCase("N.open-tabs-pick-other-window-shown", {
  setup: async () => { await SET_NT(); await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z"), { active: true }); await tab(ctx.O, "Z2", sp("Z")); await show(ctx.O, sp("Z")); await activate(ctx.tabs.Z1); await focus(ctx.W); },
  act: () => pickFrom(ctx.W, "Open Tabs", "Z2"),
  expect: async (s) => [tabIs(s, "Z2", { win: ctx.O, space: sp("Z"), active: true }), recIs(s, ctx.O, sp("Z")), focusIs(s, ctx.O), recIs(s, ctx.W, sp("X"))],
});
// ...and one parked in another window: that window switches to the tab's space first.
ntCase("N.open-tabs-pick-other-window-parked", {
  setup: async () => { await SET_NT(); await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z")); await tab(ctx.O, "Z2", sp("Z")); await focus(ctx.W); },
  act: () => pickFrom(ctx.W, "Open Tabs", "Z1"),
  expect: (s) => [tabIs(s, "Z1", { win: ctx.O, space: sp("Z"), active: true }), recIs(s, ctx.O, sp("Z")), showsSpace(s, ctx.O, sp("Z")), focusIs(s, ctx.O), recIs(s, ctx.W, sp("X"))],
});
// Recently Closed: a closed tab of the space on screen comes back in its space, shown.
ntCase("N.recently-closed-restore", {
  setup: async () => { await SET_NT(); await tab(ctx.W, "Gone1", sp("X")); await waitFor(() => h.ev(`chrome.tabs.get(${ctx.tabs.Gone1}).then((t) => t.title === "Gone1" && t.status === "complete")`, ctx.H), 8000); await sleep(400); await h.ev(`chrome.tabs.remove(${ctx.tabs.Gone1}).then(() => 1)`, ctx.H); await sleep(800); await activate(ctx.tabs.X1); await focus(ctx.W); },
  act: () => pickFrom(ctx.W, "Recently Closed", "Gone1"),
  expect: (s) => { const t = byTitle(s, "Gone1"); return [t ? null : "Gone1 was not restored", t && t.win !== ctx.W ? `restored into ${roleOf(t.win)}` : null, t && t.space !== sp("X") ? `restored into ${spaceName(t.space)}` : null,
    t && !t.active ? "the restored tab is not shown" : null, recIs(s, ctx.W, sp("X"))]; },
});
// A closed default-space tab restored while the window shows a named space: shown like a pick, so the window goes to default
// with it (repair 2 would otherwise snap back to the space and leave the tab parked).
ntCase("N.recently-closed-restore-other-space", {
  // the tab is made while the window shows its default space (a tab made on X would be X's), closed, and X shown after
  setup: async () => {
    await mkWin("W", { width: 900 }); await tab(ctx.W, "GoneD", 0); await waitFor(() => h.ev(`chrome.tabs.get(${ctx.tabs.GoneD}).then((t) => t.title === "GoneD" && t.status === "complete")`, ctx.H), 8000); await sleep(400); await h.ev(`chrome.tabs.remove(${ctx.tabs.GoneD}).then(() => 1)`, ctx.H); await sleep(800);
    await tab(ctx.W, "X1", sp("X"), { active: true }); await tab(ctx.W, "X2", sp("X")); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W);
  },
  act: () => pickFrom(ctx.W, "Recently Closed", "GoneD"),
  expect: (s) => { const t = byTitle(s, "GoneD"); return [t ? null : "GoneD was not restored", t && t.space !== 0 ? `restored into ${spaceName(t.space)}` : null, t && !t.active ? "the restored tab is not shown" : null, recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0)]; },
});
// Recently Closed Windows: Vivaldi rehomed the closed window's named-space tabs to H before it closed (D2), so its entry holds
// only its default-space tabs; the label counts those, and the restored window has exactly that many. The rehomed tabs stay in H.
def("N.closed-window-restore", {
  gesture: true,
  setup: async () => {
    await mkWin("W", { width: 900 }); await tab(ctx.W, "WD1", 0); await tab(ctx.W, "X1", sp("X")); await tab(ctx.W, "X2", sp("X")); await focus(ctx.W);
    // a tab that has not loaded is not recorded when its window closes
    for (const l of ["WD1", "X1", "X2"]) await waitFor(() => h.ev(`chrome.tabs.get(${ctx.tabs[l]}).then((t) => t.title === ${J(l)} && t.status === "complete")`, ctx.H), 8000);
    ctx.Wgone = ctx.W; await h.ev(`chrome.windows.remove(${ctx.W}).then(() => 1)`, ctx.H); delete ctx.W;
    await sleep(2500); await focus(ctx.H);
  },
  ready: async () => !!(await waitFor(() => hasEl(ctx.H, "#vm-panel .vm-newtab-chev"), 8000)),
  act: async () => {
    if (!(await openDropdown(ctx.H))) return "no dropdown";
    if (!(await openFly(ctx.H, "Recently Closed Windows"))) return "no flyout";
    ctx.closedRows = await rowsOf(ctx.H, ".vm-menu-flyout > div");
    if (!(await clickOn(ctx.H, `document.querySelector(".vm-menu-flyout .vm-menu-item")`))) return "no row";
    await waitFor(() => h.ev(`chrome.windows.getAll({ windowTypes: ["normal"] }).then((w) => w.length > 1)`, ctx.H), 8000);
    return "ok";
  },
  expect: (s) => {
    const n = newWindow(s); const w = n && normal(s).find((x) => x.id === n);
    const want = Number(/^(\d+) tabs?/.exec(ctx.closedRows?.[0] || "")?.[1]);
    return [n == null ? "no restored window" : null, w && w.tabs.length !== want ? `the label said ${ctx.closedRows[0]}, the window has ${w.tabs.length} tabs` : null,
      w && !w.tabs.some((t) => t.title === "WD1") ? "WD1 did not come back" : null, w && w.tabs.some((t) => t.ws) ? "the restored window holds a named-space tab" : null,
      tabIs(s, "X1", { win: ctx.H, space: sp("X") }), tabIs(s, "X2", { win: ctx.H, space: sp("X") })];
  },
});
// Mute All Tabs mutes every tab of this window (parked spaces too), the row then says Unmute All Tabs, which undoes it;
// another window's tabs are not touched.
ntCase("N.mute-all", {
  setup: async () => { await SET_NT(); await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z")); await focus(ctx.W); },
  act: async () => {
    const mutedOf = (label) => h.ev(`chrome.tabs.get(${ctx.tabs[label]}).then((t) => !!t.mutedInfo?.muted)`, ctx.H);
    const first = (await openDropdown(ctx.W)) ? (await rowsOf(ctx.W, NT_MENU + " > div")).filter((x) => /mute/i.test(x))[0] : "no dropdown";
    await clickOn(ctx.W, menuRow("Mute All Tabs")); await sleep(800);
    const after = { X1: await mutedOf("X1"), X2: await mutedOf("X2"), Y1: await mutedOf("Y1"), Z1: await mutedOf("Z1") };
    const reopened = await openDropdown(ctx.W);
    const second = (await rowsOf(ctx.W, NT_MENU + " > div")).filter((x) => /mute/i.test(x))[0];
    await clickOn(ctx.W, menuRow("Unmute All Tabs")); await sleep(800);
    const undone = { X1: await mutedOf("X1"), X2: await mutedOf("X2"), Y1: await mutedOf("Y1"), Z1: await mutedOf("Z1") };
    return { first, after, second, undone, reopened };
  },
  expect: (s, b, r) => [r.first === "Mute All Tabs" ? null : `first label ${r.first}`, r.after.X1 && r.after.X2 && r.after.Y1 ? null : `not all of W's tabs muted: ${J(r.after)}`, r.after.Z1 ? "another window's tab was muted" : null,
    r.second === "Unmute All Tabs" ? null : `second label ${r.second} (dropdown reopened: ${r.reopened})`, Object.values(r.undone).some(Boolean) ? `Unmute left tabs muted: ${J(r.undone)}` : null, unchanged(b, s)],
});

// ---------- Task 8l: mute a tab, and see which tabs make sound ----------
const sndUrl = (label) => `${origin}/snd-${label}`;
// Evaluate in the tab's own page, as a user gesture (a page may not play sound without one).
async function inPage(url, expr) {
  const tg = await waitFor(async () => (await targets()).find((t) => t.type === "page" && t.url === url), 6000, 200);
  if (!tg) throw new Error(`no page target for ${url}`);
  const c = await Cdp.open(tg.webSocketDebuggerUrl);
  try { return await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, userGesture: true }); } finally { c.close(); }
}
const tabState = (label) => h.ev(`chrome.tabs.get(${ctx.tabs[label]}).then((t) => ({ audible: !!t.audible, muted: !!t.mutedInfo?.muted, active: t.active }))`, ctx.H);
const activeLabel = async (win) => { const s = await h.snap(ctx.H); const a = activeOf(s, win); return a ? labelOf(a) : null; };
const TROW = (text) => `[...document.querySelectorAll("#vm-panel .vm-tab, #vm-panel .vm-link")].find((r) => r.textContent.includes(${J(text)}))`;
const rowInfo = (win, text) => h.ev(`(() => { const r = ${TROW(text)}; if (!r) return null;
  const q = (s) => r.querySelector(s), box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
  const first = r.firstElementChild;
  return { speaker: !!q(".vm-audio"), speakerTitle: q(".vm-audio")?.title ?? null, speakerBox: box(q(".vm-audio")), speakerSvg: box(q(".vm-audio svg")),
    muted: !!q(".vm-ico-muted"), mutedTitle: q(".vm-ico-muted")?.title ?? null, mutedBox: box(q(".vm-ico-muted")), favicon: !!q(".vm-ico:not(.vm-ico-muted)"),
    firstIsMuted: !!first?.classList.contains("vm-ico-muted"), speakerBeforeTitle: !!q(".vm-audio") && q(".vm-audio").nextElementSibling === q(".vm-title"),
    actBox: box(q(".vm-act")), stroke: q(".vm-audio svg, .vm-ico-muted svg") ? getComputedStyle(q(".vm-audio svg, .vm-ico-muted svg")).stroke : null }; })()`, win);
const shot = async (win, name) => {
  if (!SHOTS) return;
  const layout = await h.ev(`document.querySelector("#browser")?.classList.contains("vm-dia") ? "dia" : "arc"`, win);
  const { data } = await h.cdp(win).send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${SHOTS}/${layout}-${name}.png`, Buffer.from(data, "base64"));
};
const SET_SND = async () => {
  await mkWin("W", { width: 900 });
  await tab(ctx.W, "X1", sp("X"), { active: true });
  ctx.snd = sndUrl(`X2-${Date.now()}`); // a fresh address per case: a closed case's page may linger in the target list
  const id = await h.ev(`chrome.tabs.create({ windowId: ${ctx.W}, url: ${J(ctx.snd)}, active: false, vivExtData: ${J(J({ workspaceId: sp("X") }))} }).then((t) => t.id)`, ctx.H);
  ctx.tabs.SND = id;
  await tab(ctx.W, "Y1", sp("Y"));
  await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W);
  await waitFor(() => h.ev(`chrome.tabs.get(${id}).then((t) => t.status === "complete")`, ctx.H), 8000);
};
const sndCase = (id, c) => def(id, { gesture: true, ready: async () => (await waitFor(() => rowInfo(ctx.W, "SND-X2"), 8000)) && (await waitTile(ctx.W, "X")), setup: SET_SND, ...c });
const want = (cond, msg) => (cond ? null : msg);

// A tab playing sound shows a speaker by its name (same box as the row's other action buttons); clicking it mutes the tab
// and swaps to the crossed-out speaker in place of the favicon, without activating the row; clicking that unmutes. The
// row's own click still activates; the menu says Mute Tab / Unmute Tab and does the same, for a silent tab too.
sndCase("SND.speaker-and-menu", {
  act: async () => {
    const r = {};
    r.silent = await rowInfo(ctx.W, "SND-X2");
    await inPage(ctx.snd, "play()");
    r.playingOk = !!(await waitFor(async () => (await tabState("SND")).audible && (await rowInfo(ctx.W, "SND-X2")).speaker, 8000, 150));
    r.playing = await rowInfo(ctx.W, "SND-X2");
    r.x1Silent = await rowInfo(ctx.W, "X1");
    await shot(ctx.W, "1-playing");
    // the speaker click: mutes, must not activate X2
    await clickOn(ctx.W, `${TROW("SND-X2")}.querySelector(".vm-audio")`);
    r.muteOk = !!(await waitFor(async () => (await tabState("SND")).muted && (await rowInfo(ctx.W, "SND-X2")).muted, 6000, 150));
    r.muted = await rowInfo(ctx.W, "SND-X2");
    r.afterMute = { ...(await tabState("SND")), activeTab: await activeLabel(ctx.W) };
    await shot(ctx.W, "2-muted");
    // the row's own click still activates
    await clickOn(ctx.W, `${TROW("SND-X2")}.querySelector(".vm-title")`);
    r.rowClickActivated = !!(await waitFor(async () => (await tabState("SND")).active, 4000, 150));
    // the muted icon unmutes (and does not activate: put X1 back in front first)
    await activate(ctx.tabs.X1); await sleep(500);
    await clickOn(ctx.W, `${TROW("SND-X2")}.querySelector(".vm-ico-muted")`);
    r.unmuteOk = !!(await waitFor(async () => !(await tabState("SND")).muted && (await rowInfo(ctx.W, "SND-X2")).speaker, 6000, 150));
    r.unmuted = await rowInfo(ctx.W, "SND-X2");
    r.afterUnmute = { ...(await tabState("SND")), activeTab: await activeLabel(ctx.W) };
    // the menu, both ways
    r.menuMute = await tabMenu(ctx.W, "SND-X2", "Mute Tab");
    r.menuMuted = !!(await waitFor(async () => (await tabState("SND")).muted, 4000, 150));
    await sleep(300);
    r.menuUnmute = await tabMenu(ctx.W, "SND-X2", "Unmute Tab");
    r.menuUnmuted = !!(await waitFor(async () => !(await tabState("SND")).muted, 4000, 150));
    // a silent tab can be muted from the menu too, and then shows the crossed-out speaker
    r.silentMenu = await tabMenu(ctx.W, "X1", "Mute Tab");
    r.silentMuted = !!(await waitFor(async () => (await tabState("X1")).muted && (await rowInfo(ctx.W, "X1")).muted, 4000, 150));
    r.silentRow = await rowInfo(ctx.W, "X1");
    await tabMenu(ctx.W, "X1", "Unmute Tab");
    r.silentUnmuted = !!(await waitFor(async () => !(await tabState("X1")).muted && !(await rowInfo(ctx.W, "X1")).muted, 4000, 150));
    // the menu, open, for a screenshot
    await h.ev(`(() => { const r = ${TROW("SND-X2")}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8 })); return 1; })()`, ctx.W);
    await sleep(400); await shot(ctx.W, "3-menu"); await escapeAll(ctx.W);
    await inPage(ctx.snd, "stop()");
    return r;
  },
  expect: (s, b, r) => [
    want(!r.silent.speaker && !r.silent.muted, `a silent tab shows an audio icon: ${J(r.silent)}`),
    want(r.playingOk, "the speaker did not appear on the playing tab"),
    want(r.playing?.speaker && !r.playing.muted && r.playing.favicon, `playing row: ${J(r.playing)}`),
    want(r.playing?.speakerTitle === "Mute tab", `speaker tooltip ${r.playing?.speakerTitle}`),
    want(r.playing?.speakerBeforeTitle, "the speaker is not right before the tab's name"),
    want(J(r.playing?.speakerBox) === J(r.playing?.actBox ?? [20, 20]) || J(r.playing?.speakerBox) === "[20,20]", `speaker box ${J(r.playing?.speakerBox)} is not the action button size`),
    want(!r.x1Silent?.speaker, "the silent tab X1 shows a speaker"),
    want(r.muteOk, "clicking the speaker did not mute the tab and swap the icon"),
    want(r.muted?.firstIsMuted && !r.muted.favicon && !r.muted.speaker, `muted row: ${J(r.muted)}`),
    want(r.muted?.mutedTitle === "Unmute tab", `muted icon tooltip ${r.muted?.mutedTitle}`),
    want(r.afterMute?.activeTab === "X1" && !r.afterMute.active, `the speaker click activated the row: ${J(r.afterMute)}`),
    want(r.rowClickActivated, "the row's own click no longer activates the tab"),
    want(r.unmuteOk, "clicking the muted icon did not unmute"),
    want(r.unmuted?.speaker && r.unmuted.favicon && !r.unmuted.muted, `unmuted row: ${J(r.unmuted)}`),
    want(r.afterUnmute?.activeTab === "X1", `the muted icon click activated the row: ${J(r.afterUnmute)}`),
    want(r.menuMute?.menu?.includes("Mute Tab") && !r.menuMute.error, `menu before: ${J(r.menuMute)}`),
    want(r.menuMuted, "the menu's Mute Tab did not mute"),
    want(r.menuUnmute?.menu?.includes("Unmute Tab") && !r.menuUnmute.error, `menu after: ${J(r.menuUnmute)}`),
    want(r.menuUnmuted, "the menu's Unmute Tab did not unmute"),
    want(r.silentMuted && r.silentRow?.firstIsMuted, `a silent tab muted from the menu: ${J(r.silentRow)}`),
    want(r.silentUnmuted, "the silent tab did not unmute from the menu"),
  ],
});

// Mute All Tabs (the dropdown): every row of the window then shows the crossed-out speaker, Unmute All Tabs clears them.
sndCase("SND.mute-all-rows", {
  act: async () => {
    await inPage(ctx.snd, "play()");
    await waitFor(async () => (await tabState("SND")).audible && (await rowInfo(ctx.W, "SND-X2")).speaker, 8000, 150);
    const r = { before: await rowInfo(ctx.W, "SND-X2") };
    await dropdownItem(ctx.W, "Mute All Tabs");
    r.all = !!(await waitFor(async () => (await rowInfo(ctx.W, "SND-X2")).muted && (await rowInfo(ctx.W, "X1")).muted, 6000, 150));
    r.rows = { SND: await rowInfo(ctx.W, "SND-X2"), X1: await rowInfo(ctx.W, "X1") };
    await dropdownItem(ctx.W, "Unmute All Tabs");
    r.cleared = !!(await waitFor(async () => !(await rowInfo(ctx.W, "SND-X2")).muted && !(await rowInfo(ctx.W, "X1")).muted, 6000, 150));
    r.after = { SND: await rowInfo(ctx.W, "SND-X2"), X1: await rowInfo(ctx.W, "X1") };
    await inPage(ctx.snd, "stop()");
    return r;
  },
  expect: (s, b, r) => [want(r.before?.speaker, `no speaker before: ${J(r.before)}`), want(r.all, `Mute All did not show on the rows: ${J(r.rows)}`),
    want(r.cleared, `Unmute All did not clear the rows: ${J(r.after)}`), want(r.after?.SND?.speaker, "the still-playing tab lost its speaker after Unmute All")],
});

// Audible flaps while a video plays: count the tab events this window gets and the times its panel is rebuilt. Unmuted, a
// flap is one (debounced) rebuild; muted, the same flaps rebuild nothing.
sndCase("SND.audible-flapping", {
  act: async () => {
    await h.ev(`(() => { window.__flap = { upd: 0, aud: 0, renders: 0 };
      chrome.tabs.onUpdated.addListener((id, ch) => { window.__flap.upd++; if ("audible" in ch) window.__flap.aud++; });
      new MutationObserver(() => { window.__flap.renders++; }).observe(document.querySelector("#vm-panel"), { childList: true, subtree: true }); return 1; })()`, ctx.W);
    const flap = async (n) => {
      await h.ev(`(window.__flap.upd = window.__flap.aud = window.__flap.renders = 0, 1)`, ctx.W);
      for (let i = 0; i < n; i++) { await inPage(ctx.snd, "play()"); await sleep(1200); await inPage(ctx.snd, "stop()"); await sleep(3200); }
      await sleep(600);
      return h.ev(`({ ...window.__flap })`, ctx.W);
    };
    const r = {};
    r.unmuted = await flap(3);
    await h.ev(`chrome.tabs.update(${ctx.tabs.SND}, { muted: true }).then(() => 1)`, ctx.H); await sleep(1500);
    r.muted = await flap(3);
    return r;
  },
  expect: (s, b, r) => [want(r.unmuted.aud >= 4, `audible barely flapped while unmuted (${J(r.unmuted)})`), want(r.unmuted.renders >= 1 && r.unmuted.renders <= r.unmuted.upd, `unmuted rebuilds ${J(r.unmuted)}`),
    want(r.muted.aud >= 4, `audible barely flapped while muted (${J(r.muted)})`), want(r.muted.renders === 0, `a muted tab's audible flap rebuilt the panel ${r.muted.renders} times (${J(r.muted)})`)],
});

// Pinned rows and favorite tiles: a pinned row is a tab row (speaker by its name, crossed-out speaker for its icon); a tile
// only has its icon, so a muted tab's crossed-out speaker sits over its corner. The right-click menus of both offer Mute Tab.
def("SND.pinned-and-favorite", {
  gesture: true,
  ready: async () => (await waitFor(() => hasEl(ctx.W, "#vm-panel .vm-fav"), 8000)) || true,
  setup: async () => {
    await mkWin("W", { width: 900 });
    await tab(ctx.W, "X1", sp("X"), { active: true });
    await show(ctx.W, sp("X")); await activate(ctx.tabs.X1); await focus(ctx.W);
    const f = await waitFor(async () => { const all = await folders(); return all.X?.pinned ? all : null; });
    if (!f) throw new Error("no Pinned folder for X");
    ctx.pinUrl = sndUrl(`PIN-${Date.now()}`); ctx.favUrl = sndUrl(`FAV-${Date.now()}`);
    await bookmark(f.X.pinned, "PINSND", ctx.pinUrl);
    await bookmark(await favoritesFolder(), "FAVSND", ctx.favUrl);
    if (!(await clickPin(ctx.W, ctx.pinUrl, "PINSND"))) throw new Error("the pin is not in W's sidebar");
    if (!(await clickFav(ctx.W, "FAVSND"))) throw new Error("the favorite is not in W's sidebar");
    await waitFor(async () => (await h.snap(ctx.H)).wins.some((w) => w.tabs.some((t) => t.url === ctx.favUrl)) && (await h.snap(ctx.H)).wins.some((w) => w.tabs.some((t) => t.url === ctx.pinUrl)), 8000);
    await sleep(1200); await activate(ctx.tabs.X1); await focus(ctx.W);
  },
  act: async () => {
    const r = {};
    await inPage(ctx.pinUrl, "play()"); await inPage(ctx.favUrl, "play()");
    await waitFor(async () => (await rowInfo(ctx.W, "PINSND"))?.speaker, 8000, 150);
    r.pinPlaying = await rowInfo(ctx.W, "PINSND");
    // pinned row: right-click, Mute Tab
    const menuOn = (expr, label) => h.ev(`(async () => { const n = ${expr}; if (!n) return { error: "no node" }; const b = n.getBoundingClientRect();
      n.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8 }));
      await new Promise((r) => setTimeout(r, 250));
      const menu = [...document.querySelectorAll(".vm-menu-item")].map((d) => d.textContent); const i = [...document.querySelectorAll(".vm-menu-item")].find((d) => d.textContent === ${J(label)});
      if (!i) return { error: "no " + ${J(label)}, menu }; i.click(); return { menu }; })()`, ctx.W);
    r.pinMenu = await menuOn(TROW("PINSND"), "Mute Tab");
    r.pinMuted = !!(await waitFor(async () => (await rowInfo(ctx.W, "PINSND")).muted, 5000, 150));
    r.pinRow = await rowInfo(ctx.W, "PINSND");
    const TILE = `[...document.querySelectorAll("#vm-panel .vm-fav")].find((t) => t.title === "FAVSND")`;
    r.tileBefore = await h.ev(`!!${TILE}.querySelector(".vm-fav-muted")`, ctx.W);
    r.favMenu = await menuOn(TILE, "Mute Tab");
    r.tileMuted = !!(await waitFor(() => h.ev(`!!${TILE}.querySelector(".vm-fav-muted")`, ctx.W), 5000, 150));
    r.tileKeepsIcon = await h.ev(`!!${TILE}.querySelector(".vm-ico")`, ctx.W);
    await shot(ctx.W, "4-pinned-and-favorite");
    r.pinUnmenu = await menuOn(TROW("PINSND"), "Unmute Tab");
    r.favUnmenu = await menuOn(TILE, "Unmute Tab");
    r.cleared = !!(await waitFor(async () => !(await rowInfo(ctx.W, "PINSND")).muted && !(await h.ev(`!!${TILE}.querySelector(".vm-fav-muted")`, ctx.W)), 5000, 150));
    await inPage(ctx.pinUrl, "stop()"); await inPage(ctx.favUrl, "stop()");
    return r;
  },
  expect: (s, b, r) => [want(r.pinPlaying?.speaker, `pinned row playing: ${J(r.pinPlaying)}`), want(r.pinMenu?.menu?.includes("Mute Tab") && !r.pinMenu.error, `pinned menu ${J(r.pinMenu)}`),
    want(r.pinMuted && r.pinRow?.firstIsMuted && !r.pinRow.speaker, `pinned row muted: ${J(r.pinRow)}`),
    want(r.tileBefore === false, "a tile showed the muted badge before it was muted"), want(r.favMenu?.menu?.includes("Mute Tab") && !r.favMenu.error, `favorite menu ${J(r.favMenu)}`),
    want(r.tileMuted && r.tileKeepsIcon, `tile muted badge ${r.tileMuted}, favicon kept ${r.tileKeepsIcon}`),
    want(r.pinUnmenu?.menu?.includes("Unmute Tab") && r.favUnmenu?.menu?.includes("Unmute Tab"), `unmute menus ${J([r.pinUnmenu, r.favUnmenu])}`), want(r.cleared, "unmuting did not clear the pinned row and the tile")],
});

// Close All Tabs asks first, saying how many (folders stay); Cancel closes nothing; confirming closes what Clear does.
const SET_CLOSEALL = async () => {
  await mkWin("W", { width: 900 });
  for (const l of ["X1", "X2", "X3", "X4", "X5"]) await tab(ctx.W, l, sp("X"), { active: l === "X1" });
  await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
  // a folder made as the sidebar makes one (Vivaldi ignores a `group` written to vivExtData)
  const made = await h.ev(`vivaldi.tabsPrivate.move({ tabIds: [${ctx.tabs.X4}, ${ctx.tabs.X5}], target: ${ctx.tabs.X4}, tweaks: ["do-not-reparent", "create-new-group", "target-is-tab"], debug: "sbx" }).then((r) => r?.group || null, (e) => "err:" + e)`, ctx.W);
  if (!made || String(made).startsWith("err:")) throw new Error("no folder: " + made);
  await sleep(800); await focus(ctx.W);
};
const survivors = (s) => ["X1", "X2", "X3", "X4", "X5"].filter((l) => find(s, ctx.tabs[l])).join(",");
ntCase("N.close-all-cancel", {
  setup: SET_CLOSEALL,
  act: async () => {
    const r = await dropdownItem(ctx.W, "Close All Tabs"); if (r !== "ok") return { error: r };
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    const ask = await rowsOf(ctx.W, NT_MENU + " > div");
    await sleep(300); const before = await h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.length)`, ctx.H);
    await clickOn(ctx.W, menuRow("Cancel")); await sleep(800);
    return { ask, before, after: await h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.length)`, ctx.H) };
  },
  expect: (s, b, r) => [J(r.ask) === J(["Cancel", "Close 3 tabs (folders stay)"]) ? null : `the question was ${J(r.ask)} (Cancel first, then the question)`, r.before === r.after ? null : "Cancel closed tabs", unchanged(b, s)],
});
ntCase("N.close-all-confirm", {
  setup: SET_CLOSEALL,
  act: async () => {
    const r = await dropdownItem(ctx.W, "Close All Tabs"); if (r !== "ok") return { error: r };
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    const ask = await rowsOf(ctx.W, NT_MENU + " > div");
    await sleep(700); const early = await h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.length)`, ctx.H);
    await clickOn(ctx.W, menuRow(ask[1])); await sleep(1500);
    return { ask, early };
  },
  expect: (s, b, r) => [r.ask?.[1] === "Close 3 tabs (folders stay)" ? null : `the question was ${J(r.ask)}`, r.early === 5 + 1 ? null : `${r.early} tabs before confirming (6 incl. W's start tab)`,
    survivors(s) === "X4,X5" ? null : `survivors ${survivors(s)}, want the folder's X4,X5`, inSpace(s, sp("X")).every((t) => t.win === ctx.W) ? null : "tabs moved window"],
});
// The same setup, closed with the existing Clear button: the same survivors (the reuse is the point).
ntCase("N.clear-button-same-set", {
  setup: SET_CLOSEALL,
  act: async () => { await h.ev(`document.querySelector("#vm-panel .vm-clear").click()`, ctx.W); await sleep(1500); return "ok"; },
  expect: (s) => [survivors(s) === "X4,X5" ? null : `Clear left ${survivors(s)}`],
});
// Empty and failing lists never throw into the UI: one disabled row says so.
ntCase("N.flyout-empty-and-error", {
  act: async () => {
    await h.ev(`(() => { window.__realClosed = chrome.sessions.getRecentlyClosed; chrome.sessions.getRecentlyClosed = () => Promise.resolve([]); return 1; })()`, ctx.W);
    let empty, failed;
    try {
      await openDropdown(ctx.W); await openFly(ctx.W, "Recently Closed"); empty = await rowsOf(ctx.W, ".vm-menu-flyout > div");
      await hoverOn(ctx.W, menuRow("Recently Closed Windows")); await sleep(600); const emptyW = await rowsOf(ctx.W, ".vm-menu-flyout > div"); empty = [...empty, ...emptyW];
      await escapeAll(ctx.W);
      await h.ev(`(chrome.sessions.getRecentlyClosed = () => Promise.reject(new Error("boom")), 1)`, ctx.W);
      await openDropdown(ctx.W); await openFly(ctx.W, "Recently Closed"); failed = await rowsOf(ctx.W, ".vm-menu-flyout > div");
      await escapeAll(ctx.W);
    } finally { await h.ev(`(chrome.sessions.getRecentlyClosed = window.__realClosed, 1)`, ctx.W); }
    return { empty, failed };
  },
  expect: (s, b, r) => [J(r.empty) === J(["Nothing here (disabled)", "Nothing here (disabled)"]) ? null : `empty lists: ${J(r.empty)}`, J(r.failed) === J(["Could not load this (disabled)"]) ? null : `a failing list: ${J(r.failed)}`, unchanged(b, s)],
});
// The flyout flips to the other side when it would run off the window.
ntCase("N.flyout-flips", {
  act: async () => {
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    await h.ev(`(() => { const m = document.querySelector(${J(NT_MENU)}); m.style.left = (innerWidth - m.getBoundingClientRect().width - 8) + "px"; return 1; })()`, ctx.W);
    if (!(await openFly(ctx.W, "Open Tabs"))) return { error: "no flyout" };
    const box = await h.ev(`(() => { const f = document.querySelector(".vm-menu-flyout").getBoundingClientRect(), m = document.querySelector(${J(NT_MENU)}).getBoundingClientRect(); return { fRight: f.right, fLeft: f.left, mLeft: m.left, vw: innerWidth }; })()`, ctx.W);
    await escapeAll(ctx.W);
    return box;
  },
  expect: (s, b, r) => [r.error ?? null, r.fRight <= r.vw ? null : `the flyout runs off the window: ${J(r)}`, r.fRight <= r.mLeft + 6 ? null : `it did not flip to the menu's left side: ${J(r)}`],
});
// Existing flat menus render exactly as before (golden: captured from the build before this task): a tab row's menu has
// plain items, dividers and no rich/flyout markup, and the delete confirmation keeps its danger row.
ntCase("N.flat-menus-unchanged", {
  act: async () => {
    const tabHtml = await h.ev(`(() => { const r = [...document.querySelectorAll(".vm-tab")].find((r) => r.textContent.includes("X2")); const b = r.getBoundingClientRect();
      r.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8 })); const m = document.querySelector(".vm-menu"); return m ? m.outerHTML.replace(/ style="[^"]*"/, "") : null; })()`, ctx.W);
    await escapeAll(ctx.W); await sleep(200);
    const del = await deleteLabel(ctx.W, "Y");
    return { tabHtml, del };
  },
  expect: (s, b, r) => {
    const g = (parts) => `<div class="vm-menu">${parts.map((p) => (p === "-" ? '<div class="vm-menu-sep"></div>' : `<div class="vm-menu-item">${p}</div>`)).join("")}</div>`;
    const want = g(["Pin Tab", "Add to Favorites", "-", "Move to Vivarc", "Move to Y", "Move to Z", "-", "Duplicate Tab", "Copy Link", "Mute Tab", "-", "Close Tab", "Close Other Tabs"]);
    return [r.tabHtml === want ? null : `the tab menu changed:\n        ${r.tabHtml}\n        want ${want}`, r.del?.label === "Delete “Y” and close its 1 tab" ? null : `the delete confirmation changed: ${J(r.del)}`, unchanged(b, s)];
  },
});

// ---------- Task 8k follow-ups (8n): the dropdown's small fixes ----------
// The confirm menu opens with the pointer on Cancel: a second click at the same spot (a double-click) cannot confirm.
ntCase("N.close-all-doubleclick", {
  setup: SET_CLOSEALL,
  act: async () => {
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    const p = await hoverOn(ctx.W, menuRow("Close All Tabs")); if (!p) return { error: "no Close All Tabs row" };
    const count = () => h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.length)`, ctx.H);
    const before = await count();
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y); // the click that opens the question
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    const under = await h.ev(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.textContent || e.className).slice(0, 40) : null; })()`, ctx.W);
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y); // ...and the second click of a double-click
    await sleep(1200);
    return { before, after: await count(), under };
  },
  expect: (s, b, r) => [r.before === r.after ? null : `a double-click closed tabs (${r.before} -> ${r.after}); the pointer was on ${J(r.under)}`, r.under?.startsWith("Close ") ? `the destructive row was under the pointer: ${J(r.under)}` : null, unchanged(b, s)],
});
// The chevron's highlight (.open) goes out however the menu closes: Escape, a click outside, picking a row.
ntCase("N.chevron-open-clears", {
  act: async () => {
    const lit = () => hasEl(ctx.W, "#vm-panel .vm-newtab-chev.open");
    const out = {};
    await openDropdown(ctx.W); out.litOpen = await lit();
    await escapeAll(ctx.W); await sleep(250); out.escape = await lit();
    await openDropdown(ctx.W);
    await mouse(ctx.W, "mousePressed", 700, 420); await mouse(ctx.W, "mouseReleased", 700, 420); await sleep(250); out.outside = await lit(); out.outsideMenu = await hasEl(ctx.W, ".vm-menu");
    await openDropdown(ctx.W);
    await clickOn(ctx.W, menuRow("Search Tabs…")); await sleep(300); out.pick = await lit();
    await h.ev(`document.querySelector("#vm-cmd input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) ?? 1`, ctx.W);
    return out;
  },
  expect: (s, b, r) => [r.litOpen ? null : "the chevron did not light while the menu was open", r.escape ? "still lit after Escape" : null, r.outsideMenu ? "a click outside did not close the menu" : null,
    r.outside ? "still lit after a click outside" : null, r.pick ? "still lit after picking a row" : null, unchanged(b, s)],
});
// Mute All Tabs: one tab that cannot be muted does not fail the rest, and the toast says how many failed.
ntCase("N.mute-all-partial", {
  act: async () => {
    const mutedOf = (label) => h.ev(`chrome.tabs.get(${ctx.tabs[label]}).then((t) => !!t.mutedInfo?.muted)`, ctx.H);
    const stub = (rule) => h.ev(`(() => { window.__realUpdate ||= chrome.tabs.update.bind(chrome.tabs); chrome.tabs.update = (id, props, ...rest) => (props && props.muted !== undefined && (${rule}) ? Promise.reject(new Error("cannot")) : window.__realUpdate(id, props, ...rest)); return 1; })()`, ctx.W);
    const out = {};
    try {
      await stub(`id === ${ctx.tabs.X2}`);
      await dropdownItem(ctx.W, "Mute All Tabs"); out.toast1 = await waitFor(() => toastNow(ctx.W), 5000, 100);
      out.muted1 = { X1: await mutedOf("X1"), X2: await mutedOf("X2"), Y1: await mutedOf("Y1") };
      await h.ev(`chrome.tabs.update = window.__realUpdate; 1`, ctx.W);
      await h.ev(`(async () => { for (const t of await chrome.tabs.query({ windowId: ${ctx.W} })) await chrome.tabs.update(t.id, { muted: false }); return 1; })()`, ctx.W);
      await sleep(2600); // the first toast goes
      await stub("true");
      await dropdownItem(ctx.W, "Mute All Tabs"); out.toast2 = await waitFor(() => toastNow(ctx.W), 5000, 100);
    } finally { await h.ev(`(window.__realUpdate && (chrome.tabs.update = window.__realUpdate), 1)`, ctx.W); }
    return out;
  },
  expect: (s, b, r) => [/^Could not mute 1 of \d+ tabs$/.test(r.toast1 || "") ? null : `partial failure toast ${J(r.toast1)}`, r.muted1?.X1 && r.muted1?.Y1 ? null : `the other tabs were not muted: ${J(r.muted1)}`, r.muted1?.X2 ? "X2 should not have muted" : null,
    r.toast2 === "Could not mute any tab" ? null : `total failure toast ${J(r.toast2)}`, unchanged(b, s)],
});
// Picking a tab in a minimised window brings the window back (not just focus).
ntCase("N.open-tabs-pick-minimised", {
  setup: async () => { await SET_NT(); await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z"), { active: true }); await tab(ctx.O, "Z2", sp("Z")); await show(ctx.O, sp("Z")); await activate(ctx.tabs.Z1); await focus(ctx.W);
    await h.ev(`chrome.windows.update(${ctx.O}, { state: "minimized" }).then(() => 1)`, ctx.H); await sleep(800); },
  act: async () => {
    const before = await h.ev(`chrome.windows.get(${ctx.O}).then((w) => w.state)`, ctx.H);
    const r = await pickFrom(ctx.W, "Open Tabs", "Z2"); if (r !== "ok") return r;
    await sleep(1200);
    return { before, state: await h.ev(`chrome.windows.get(${ctx.O}).then((w) => w.state)`, ctx.H) };
  },
  expect: (s, b, r) => [r.before === "minimized" ? null : `the setup did not minimise O (${r.before})`, r.state === "normal" ? null : `O is ${r.state}, want normal`, tabIs(s, "Z2", { win: ctx.O, space: sp("Z"), active: true }), focusIs(s, ctx.O)],
});

// ---------- Task 8n: Clean Up Tabs, Clean Up Daily, Recently Cleaned ----------
// Vivaldi's lastAccessed cannot be backdated, so these use the cleanup module's test hook, window.__vm.cleanup.test (null
// unless set here): { idleMs, now }. "Old" tabs are made, 3 s pass, "fresh" ones are made, and the clock is frozen at that
// moment with an idle limit of 2.5 s: the old tabs are idle, the fresh ones are not. What the hook does NOT replace: the menu,
// the toast, Undo, the flyout, the real store, the real chrome.tabs.remove / create, the leader check, the settings toggle.
const IDLE = 2500;
const freeze = async (win, at, idle = IDLE) => { await h.ev(`(window.__vm.cleanup.test = { idleMs: ${idle}, now: () => ${at} }, 1)`, win); return at; };
const toastNow = (win) => h.ev(`document.querySelector("#vm-copied")?.textContent || null`, win);
const cleanedList = (win) => h.ev(`window.__vm.cleanup.list().then((l) => l.map((e) => ({ title: e.title, space: e.space, at: e.cleanedAt, url: e.url })))`, win);
const titles = (s, title) => normal(s).flatMap((w) => w.tabs.filter((t) => t.title === title).map((t) => ({ ...t, win: w.id, space: t.ws ?? 0 })));
const loaded = (labels) => waitFor(() => h.ev(`Promise.all(${J(labels.map((l) => ctx.tabs[l]))}.map((id) => chrome.tabs.get(id))).then((ts) => ts.every((t) => t.status === "complete"))`, ctx.H), 10000);
// W (900 wide) shows X: X1 active, X2 X3 idle, Xp pinned, Xb a favorite's tab (vivarcPin), X4 fresh; Y1 idle in the parked space Y; D1 idle in
// the default space. O shows Z: Z1 active, Z2 idle. age: false skips the wait, so nothing is idle.
const SET_CU = async ({ age = true } = {}) => {
  await mkWin("W", { width: 900 });
  await tab(ctx.W, "X1", sp("X"), { active: true }); for (const l of ["X2", "X3", "Xp"]) await tab(ctx.W, l, sp("X"));
  await tab(ctx.W, "Y1", sp("Y")); await tab(ctx.W, "D1", 0);
  await mkWin("O", { width: 700 }); await tab(ctx.O, "Z1", sp("Z"), { active: true }); await tab(ctx.O, "Z2", sp("Z"));
  await show(ctx.O, sp("Z")); await activate(ctx.tabs.Z1); await show(ctx.W, sp("X")); await activate(ctx.tabs.X1);
  await h.ev(`chrome.tabs.update(${ctx.tabs.Xp}, { pinned: true }).then(() => 1)`, ctx.H);
  // Xb: a real favorite opened from the sidebar, so its tab carries vivarcPin (a hand-written one is stripped by the pins module)
  const xbUrl = `${origin}/xb-${Date.now()}`;
  await bookmark(await favoritesFolder(), "Xb", xbUrl);
  if (!(await clickFav(ctx.W, "Xb"))) throw new Error("the favorite Xb is not in W sidebar");
  const xb = await waitFor(async () => tabsFor(await h.snap(ctx.H), xbUrl)[0], 8000);
  if (!xb) throw new Error("opening the favorite made no tab");
  ctx.tabs.Xb = xb.id; await sleep(800); await activate(ctx.tabs.X1);
  await loaded(["X1", "X2", "X3", "Xp", "Xb", "Y1", "D1", "Z1", "Z2"]);
  await focus(ctx.W);
  if (age) await sleep(3200);
  await tab(ctx.W, "X4", sp("X")); await loaded(["X4"]);
  ctx.frozen = Date.now();
  for (const w of [ctx.H, ctx.W, ctx.O]) await freeze(w, ctx.frozen, age ? IDLE : 600000);
  await focus(ctx.W);
};
const cuCase = (id, c) => ntCase(id, { setup: SET_CU, ...c });
const gone = (s, ...labels) => labels.map((l) => (find(s, ctx.tabs[l]) ? `${l} was not cleaned` : null));
const kept = (s, ...labels) => labels.map((l) => (find(s, ctx.tabs[l]) ? null : `${l} was cleaned`));
const cleanUpFromMenu = async () => { const r = await dropdownItem(ctx.W, "Clean Up Tabs"); return r; };

// The dropdown has the two rows, the toggle is off by default, a click turns it on (saved per profile, ✓ shown), another turns it off,
// and the setting is in Vivarc Settings too.
cuCase("CU.menu-rows-and-toggle", {
  act: async () => {
    const out = {};
    const checkState = () => h.ev(`(() => { const r = [...document.querySelectorAll(${J(NT_MENU + " .vm-menu-item")})].find((n) => n.textContent.includes("Clean Up Daily")); return r ? { check: r.querySelector(".vm-menu-check")?.textContent ?? null, aria: r.getAttribute("aria-checked"), role: r.getAttribute("role") } : null; })()`, ctx.W);
    const others = () => h.ev(`[...document.querySelectorAll(${J(NT_MENU + " .vm-menu-item")})].filter((n) => !n.textContent.includes("Clean Up Daily") && n.querySelector(".vm-menu-check")).length`, ctx.W);
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    out.labels = await rowsOf(ctx.W, NT_MENU + " > div"); out.off = await checkState(); out.others = await others(); out.defaultSaved = await h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.W);
    await clickOn(ctx.W, menuRow("Clean Up Daily")); await sleep(500);
    out.menuClosed = !(await hasEl(ctx.W, ".vm-menu"));
    out.on = await h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.W);
    out.stored = await h.ev(`window.__vm.store.get("settings", {}).then((s) => s.cleanupDaily)`, ctx.W);
    out.otherWindow = await waitFor(() => h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.O), 3000, 100);
    await openDropdown(ctx.W); out.checked = await checkState();
    await escapeAll(ctx.W); await sleep(200);
    await h.ev(`window.dispatchEvent(new CustomEvent("vm-open-settings")), 1`, ctx.W); await sleep(400);
    out.settingsRow = await h.ev(`[...document.querySelectorAll(".vm-set-row")].map((r) => r.querySelector(".vm-set-label")?.textContent).find((t) => /Clean up tabs daily/.test(t || "")) ?? null`, ctx.W);
    out.settingsOn = await h.ev(`(() => { const r = [...document.querySelectorAll(".vm-set-row")].find((r) => /Clean up tabs daily/.test(r.textContent)); return r?.querySelector("input")?.checked ?? null; })()`, ctx.W);
    await h.ev(`window.dispatchEvent(new CustomEvent("vm-open-settings")), 1`, ctx.W); await sleep(300);
    await openDropdown(ctx.W); await clickOn(ctx.W, menuRow("Clean Up Daily")); await sleep(500);
    out.backOff = await h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.W);
    return out;
  },
  expect: (s, b, r) => [J(r.labels?.map((l) => l.replace(" (disabled)", ""))) === J(NT_LABELS) ? null : `menu rows ${J(r.labels)}`, r.off?.check === "" && r.off?.aria === "false" && r.off?.role === "menuitemcheckbox" ? null : `off state ${J(r.off)}`,
    r.others === 0 ? null : `${r.others} other rows got a check slot`, r.defaultSaved === false ? null : "the toggle is not off by default", r.menuClosed ? null : "the menu stayed open", r.on === true && r.stored === true ? null : `on ${r.on}, stored ${r.stored}`,
    r.otherWindow === true ? null : "the other window did not hear the setting", r.checked?.check === "✓" && r.checked?.aria === "true" ? null : `on state ${J(r.checked)}`,
    r.settingsRow === "Clean up tabs daily (idle 7 days)" && r.settingsOn === true ? null : `Vivarc Settings: ${J(r.settingsRow)} ${r.settingsOn}`, r.backOff === false ? null : "a second click did not turn it off", unchanged(b, s)],
});
// Clean Up Tabs: this window's space on screen only; idle tabs go, and the never-cleaned ones stay (active, pinned, bound, fresh, other spaces/windows).
cuCase("CU.clean-space", {
  act: async () => {
    const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r };
    const toast = await waitFor(() => toastNow(ctx.W), 6000, 100);
    const undo = await hasEl(ctx.W, "#vm-copied .vm-toast-action");
    await sleep(800);
    return { toast, undo, list: await cleanedList(ctx.W) };
  },
  expect: (s, b, r) => [...gone(s, "X2", "X3"), ...kept(s, "X1", "Xp", "Xb", "X4", "Y1", "D1", "Z1", "Z2"), tabIs(s, "X1", { win: ctx.W, active: true }), r.toast === "Cleaned 2 tabsUndo" || r.toast === "Cleaned 2 tabs" || /^Cleaned 2 tabs/.test(r.toast || "") ? null : `toast ${J(r.toast)}`,
    r.undo ? null : "the toast has no Undo button", J(r.list.map((e) => e.title).sort()) === J(["X2", "X3"]) ? null : `Recently Cleaned holds ${J(r.list.map((e) => e.title))}`,
    r.list.every((e) => e.space === sp("X") && e.at === ctx.frozen && e.url.startsWith("data:")) ? null : `entries ${J(r.list)}`, recIs(s, ctx.W, sp("X")), recIs(s, ctx.O, sp("Z"))],
});
// Undo reopens exactly those tabs, in their space, off the list; the tab on screen is still X1.
cuCase("CU.undo", {
  act: async () => {
    const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r };
    if (!(await waitFor(() => h.ev(`!!document.querySelector("#vm-copied .vm-toast-action")`, ctx.W), 6000, 100))) return { error: "no Undo button" };
    const mid = await h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.filter((x) => x.title === "X2" || x.title === "X3").length)`, ctx.H);
    await h.ev(`document.querySelector("#vm-copied .vm-toast-action").click()`, ctx.W);
    await waitFor(() => h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.filter((x) => x.title === "X2" || x.title === "X3").length === 2)`, ctx.H), 8000, 200);
    await sleep(1200);
    return { mid, list: await cleanedList(ctx.W), toast: await toastNow(ctx.W) };
  },
  expect: (s, b, r) => { const x2 = titles(s, "X2"), x3 = titles(s, "X3"); return [r.mid === 0 ? null : `${r.mid} of X2/X3 still open before Undo`,
    x2.length === 1 && x3.length === 1 ? null : `X2 x${x2.length}, X3 x${x3.length} after Undo`, x2[0] && (x2[0].win !== ctx.W || x2[0].space !== sp("X")) ? `X2 in ${roleOf(x2[0].win)}/${spaceName(x2[0].space)}` : null,
    x3[0] && (x3[0].win !== ctx.W || x3[0].space !== sp("X")) ? `X3 in ${roleOf(x3[0].win)}/${spaceName(x3[0].space)}` : null, r.list.length === 0 ? null : `still listed: ${J(r.list)}`,
    tabIs(s, "X1", { win: ctx.W, active: true }), recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]; },
});
// Nothing idle: a toast says so and nothing changes.
cuCase("CU.nothing-to-clean", {
  setup: () => SET_CU({ age: false }),
  act: async () => {
    const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r };
    const toast = await waitFor(() => toastNow(ctx.W), 5000, 100);
    return { toast, list: await cleanedList(ctx.W) };
  },
  expect: (s, b, r) => [r.toast === "Nothing to clean" ? null : `toast ${J(r.toast)}`, r.list.length === 0 ? null : `the list has ${J(r.list)}`, unchanged(b, s)],
});
// The list is written BEFORE the tabs close, and the repair busy mark stands while they do.
cuCase("CU.store-before-close", {
  act: async () => {
    await h.ev(`(() => { window.__realRemove = chrome.tabs.remove.bind(chrome.tabs); chrome.tabs.remove = async (ids) => {
      window.__seen = { ids: [].concat(ids), listed: (await window.__vm.store.get("cleaned", [])).map((e) => e.title), busyMs: (Number(chrome.extension.getBackgroundPage().__vivarcSpaceGesture) || 0) - Date.now() };
      return window.__realRemove(ids); }; return 1; })()`, ctx.W);
    let seen;
    try { const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r }; await waitFor(() => toastNow(ctx.W), 6000, 100); await sleep(500); seen = await h.ev(`window.__seen`, ctx.W); }
    finally { await h.ev(`(window.__realRemove && (chrome.tabs.remove = window.__realRemove), 1)`, ctx.W); }
    return { seen, ids: [ctx.tabs.X2, ctx.tabs.X3] };
  },
  expect: (s, b, r) => [r.seen ? null : "chrome.tabs.remove never ran", J([...(r.seen?.ids || [])].sort()) === J([...r.ids].sort()) ? null : `closed ${J(r.seen?.ids)}`, J([...(r.seen?.listed || [])].sort()) === J(["X2", "X3"]) ? null : `the list at the moment of closing: ${J(r.seen?.listed)}`,
    r.seen?.busyMs > 0 ? null : `no repair busy mark while closing (${r.seen?.busyMs})`, ...gone(s, "X2", "X3")],
});
// Closing fails: the tabs stay, the list does not claim them, the toast says so.
cuCase("CU.close-fails", {
  act: async () => {
    await h.ev(`(() => { window.__realRemove = chrome.tabs.remove.bind(chrome.tabs); chrome.tabs.remove = () => Promise.reject(new Error("no")); return 1; })()`, ctx.W);
    try { const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r }; const toast = await waitFor(() => toastNow(ctx.W), 6000, 100); await sleep(500); return { toast, list: await cleanedList(ctx.W) }; }
    finally { await h.ev(`(window.__realRemove && (chrome.tabs.remove = window.__realRemove), 1)`, ctx.W); }
  },
  expect: (s, b, r) => [r.toast === "Could not clean up the tabs" ? null : `toast ${J(r.toast)}`, r.list.length === 0 ? null : `the list claims ${J(r.list.map((e) => e.title))}`, unchanged(b, s)],
});
// The store keeps 30 days and 200 entries, newest first.
cuCase("CU.store-pruned", {
  act: async () => {
    await h.ev(`(async () => { const f = ${ctx.frozen}, D = 86400000; const seed = Array.from({ length: 199 }, (_, i) => ({ url: "https://e.test/s" + i, title: "s" + i, favIconUrl: "", space: 0, cleanedAt: f - (i + 1) * 60000 }));
      seed.push({ url: "https://e.test/d29", title: "d29", favIconUrl: "", space: 0, cleanedAt: f - 29 * D }, { url: "https://e.test/d31", title: "d31", favIconUrl: "", space: 0, cleanedAt: f - 31 * D });
      await window.__vm.store.set("cleaned", seed); return 1; })()`, ctx.W);
    const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r };
    await waitFor(() => toastNow(ctx.W), 6000, 100); await sleep(500);
    return { list: await cleanedList(ctx.W) };
  },
  expect: (s, b, r) => { const t = r.list.map((e) => e.title); return [r.list.length === 200 ? null : `kept ${r.list.length}, want 200`, J(t.slice(0, 2).sort()) === J(["X2", "X3"]) ? null : `newest first? ${J(t.slice(0, 3))}`,
    t.includes("d31") ? "the 31-day-old entry was kept" : null, t.includes("d29") ? "the 29-day-old entry should have been the one to drop for the 200 cap" : null,
    r.list.every((e, i, a) => !i || a[i - 1].at >= e.at) ? null : "not newest first"]; },
});
// Open the Recently Cleaned flyout after the menu cleaned this window's space: rows with favicon, title, age; a click reopens in its space and shows it.
cuCase("CU.flyout-restore", {
  act: async () => {
    const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r };
    await waitFor(() => toastNow(ctx.W), 6000, 100); await sleep(900);
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    if (!(await openFly(ctx.W, "Recently Cleaned"))) return { error: "no flyout" };
    const rows = await rowsOf(ctx.W, ".vm-menu-flyout > div");
    const notes = await h.ev(`[...document.querySelectorAll(".vm-menu-flyout .vm-menu-note")].map((n) => n.textContent)`, ctx.W);
    const icons = await h.ev(`document.querySelectorAll(".vm-menu-flyout .vm-ico").length`, ctx.W);
    if (!(await clickOn(ctx.W, flyRow("X2")))) return { error: `no X2 row: ${J(rows)}` };
    await waitFor(() => h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.some((x) => x.title === "X2"))`, ctx.H), 8000, 200);
    await sleep(1500);
    return { rows, notes, icons, list: await cleanedList(ctx.W), menuGone: !(await hasEl(ctx.W, ".vm-menu")) };
  },
  expect: (s, b, r) => { const x2 = titles(s, "X2"); return [J(r.rows) === J(["X3", "X2", "---", "Clear list"]) && J(r.notes) === J(["today", "today"]) ? null : `flyout ${J(r.rows)} notes ${J(r.notes)}`, r.icons === 2 ? null : `${r.icons} favicons`,
    x2.length === 1 ? null : `X2 x${x2.length}`, x2[0] && (x2[0].win !== ctx.W || x2[0].space !== sp("X")) ? `X2 in ${roleOf(x2[0].win)}/${spaceName(x2[0].space)}` : null, x2[0] && !x2[0].active ? "the reopened tab is not shown" : null,
    J(r.list.map((e) => e.title)) === J(["X3"]) ? null : `list after: ${J(r.list.map((e) => e.title))}`, r.menuGone ? null : "the menu stayed open", recIs(s, ctx.W, sp("X")), showsSpace(s, ctx.W, sp("X"))]; },
});
// A tab of a space that lives in another window comes back in THAT window, shown the way a pick shows it.
cuCase("CU.flyout-restore-other-window", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.O}, space: ${sp("Z")} }).then((r) => r.count)`, ctx.W);
    await sleep(900);
    return pickFrom(ctx.W, "Recently Cleaned", "Z2");
  },
  expect: async (s) => { await sleep(1500); const z = titles(s, "Z2"); return [z.length === 1 ? null : `Z2 x${z.length}`, z[0] && (z[0].win !== ctx.O || z[0].space !== sp("Z")) ? `Z2 in ${roleOf(z[0].win)}/${spaceName(z[0].space)}` : null,
    z[0] && !z[0].active ? "Z2 is not shown" : null, recIs(s, ctx.O, sp("Z")), recIs(s, ctx.W, sp("X")), focusIs(s, ctx.O)]; },
});
// The space was deleted since: the tab comes back in the space on screen in this window.
cuCase("CU.flyout-restore-deleted-space", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("Y")} }).then((r) => r.count)`, ctx.W);
    await sleep(600);
    await h.ev(`window.__sbx.mgr.removeWorkspace(${ctx.W}, ${sp("Y")}).then(() => 1, () => 0)`, ctx.W); await sleep(1500);
    return pickFrom(ctx.W, "Recently Cleaned", "Y1");
  },
  expect: (s) => { const y = titles(s, "Y1"); return [y.length === 1 ? null : `Y1 x${y.length}`, y[0] && (y[0].win !== ctx.W || y[0].space !== sp("X")) ? `Y1 in ${roleOf(y[0].win)}/${spaceName(y[0].space)}, want W/X (the space on screen)` : null,
    y[0] && !y[0].active ? "Y1 is not shown" : null, recIs(s, ctx.W, sp("X"))]; },
});
// A default-space tab comes back in the default space even while the window shows a named one.
cuCase("CU.flyout-restore-default-space", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: 0 }).then((r) => r.count)`, ctx.W);
    await sleep(900);
    return pickFrom(ctx.W, "Recently Cleaned", "D1");
  },
  expect: (s) => { const d = titles(s, "D1"); return [d.length === 1 ? null : `D1 x${d.length}`, d[0] && (d[0].win !== ctx.W || d[0].space !== 0) ? `D1 in ${roleOf(d[0].win)}/${spaceName(d[0].space)}` : null,
    d[0] && !d[0].active ? "D1 is not shown" : null, recIs(s, ctx.W, 0), showsSpace(s, ctx.W, 0)]; },
});
// Clear list asks first with Cancel under the pointer; a second click at that spot does not confirm; confirming empties the list and the row goes disabled.
cuCase("CU.clear-list", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W);
    await sleep(900);
    const out = {};
    if (!(await openDropdown(ctx.W)) || !(await openFly(ctx.W, "Recently Cleaned"))) return { error: "no flyout" };
    const p = await hoverOn(ctx.W, flyRow("Clear list"));
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y);
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    out.ask = await rowsOf(ctx.W, NT_MENU + " > div");
    out.under = await h.ev(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? (e.textContent || e.className).slice(0, 40) : null; })()`, ctx.W);
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y); await sleep(600); // the second click of a double-click
    out.afterDouble = (await cleanedList(ctx.W)).length;
    if (!(await hasEl(ctx.W, ".vm-menu"))) { await openDropdown(ctx.W); await openFly(ctx.W, "Recently Cleaned"); await clickOn(ctx.W, flyRow("Clear list")); await waitFor(() => hasEl(ctx.W, NT_MENU), 3000); }
    await clickOn(ctx.W, menuRow("Cancel")); await sleep(500);
    out.afterCancel = (await cleanedList(ctx.W)).length;
    await openDropdown(ctx.W); await openFly(ctx.W, "Recently Cleaned"); await clickOn(ctx.W, flyRow("Clear list"));
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    await sleep(600); await clickOn(ctx.W, menuRow(out.ask[1])); await sleep(700);
    out.afterClear = (await cleanedList(ctx.W)).length;
    await openDropdown(ctx.W); out.rowAfter = (await rowsOf(ctx.W, NT_MENU + " > div")).find((x) => x.startsWith("Recently Cleaned"));
    await escapeAll(ctx.W);
    return out;
  },
  expect: (s, b, r) => [r.error ?? null, J(r.ask) === J(["Cancel", "Clear 2 cleaned tabs"]) ? null : `the question was ${J(r.ask)}`, r.under?.startsWith("Clear ") ? `the destructive row was under the pointer: ${J(r.under)}` : null,
    r.afterDouble === 2 ? null : `a double-click changed the list (${r.afterDouble})`, r.afterCancel === 2 ? null : `Cancel changed the list (${r.afterCancel})`, r.afterClear === 0 ? null : `still ${r.afterClear} after confirming`,
    r.rowAfter === "Recently Cleaned (disabled)" ? null : `Recently Cleaned row after: ${J(r.rowAfter)}`],
});
// Clean Up Daily: ONE window runs it (the leader), once a day, across every space of every window, silently, with the usual exclusions.
cuCase("CU.daily-leader-once", {
  act: async () => {
    const out = {};
    const tick = (win) => h.ev(`window.__vm.cleanup.tick()`, win);
    const count = () => h.ev(`chrome.tabs.query({ windowType: "normal" }).then((t) => t.length)`, ctx.H);
    const hook = (win) => h.ev(`(() => { window.__logs = []; if (window.__logHook) return 1; window.__logHook = true; const o = console.log.bind(console); console.log = (...a) => { window.__logs.push(a.map(String).join(" ")); o(...a); }; return 1; })()`, win);
    for (const w of [ctx.H, ctx.W, ctx.O]) await hook(w);
    out.offTick = await tick(ctx.H);                                      // the toggle is off by default
    await dropdownItem(ctx.W, "Clean Up Daily");                          // turned on from W's menu, as a user would
    out.heard = await waitFor(() => h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.H), 4000, 100);
    await h.ev(`window.__vm.store.set("lastCleanup", ${ctx.frozen - 25 * 3600 * 1000}).then(() => 1)`, ctx.H); // last ran 25 h ago
    out.before = await count();
    out.nonLeader = await tick(ctx.W); out.nonLeaderO = await tick(ctx.O);
    out.afterNonLeader = await count();
    out.parallel = await Promise.all([tick(ctx.H), tick(ctx.H)]);        // start-up and the timer at once
    await sleep(2000);
    out.after = await count();
    out.again = await tick(ctx.H); out.againW = await tick(ctx.W);
    out.last = await h.ev(`window.__vm.store.get("lastCleanup", 0)`, ctx.H);
    out.logs = { H: await h.ev(`window.__logs.filter((l) => l.includes("cleanup:"))`, ctx.H), W: await h.ev(`window.__logs.filter((l) => l.includes("cleanup:"))`, ctx.W), O: await h.ev(`window.__logs.filter((l) => l.includes("cleanup:"))`, ctx.O) };
    out.toasts = [await toastNow(ctx.H), await toastNow(ctx.W), await toastNow(ctx.O)];
    out.list = (await cleanedList(ctx.H)).map((e) => e.title).sort();
    out.allLogs = await h.ev(`window.__logs`, ctx.H);
    return out;
  },
  expect: (s, b, r) => [r.error ?? null, r.offTick === "off" ? null : `with the toggle off the tick said ${J(r.offTick)}`, r.heard === true ? null : "the leader did not hear the toggle",
    r.nonLeader === "not leader" && r.nonLeaderO === "not leader" ? null : `non-leaders said ${J([r.nonLeader, r.nonLeaderO])}`, r.afterNonLeader === r.before ? null : "a non-leader closed tabs",
    r.parallel.filter((x) => x === 7).length === 1 && r.parallel.filter((x) => x === "busy").length === 1 ? null : `two ticks at once: ${J(r.parallel)}`,
    r.before - r.after === 7 ? null : `${r.before - r.after} tabs closed, want 7 (X2 X3 Y1 D1 Z2 and the idle start tabs of W and O)`, ...gone(s, "X2", "X3", "Y1", "D1", "Z2"), titles(s, "W-d0").length || titles(s, "O-d0").length ? "an idle start tab was not cleaned" : null, ...kept(s, "X1", "Xp", "Xb", "X4", "Z1"),
    r.again === "not due" ? null : `a second look said ${J(r.again)}`, r.againW === "not leader" ? null : `W's look said ${J(r.againW)}`, r.last === ctx.frozen ? null : `lastCleanup ${r.last}, want ${ctx.frozen}`,
    J(r.logs.H) === J(["[vivarc] cleanup: 7 tabs"]) && !r.logs.W.length && !r.logs.O.length ? null : `log lines ${J(r.logs)}`, r.toasts.every((t) => t === null) ? null : `a toast showed: ${J(r.toasts)}`,
    J(r.list) === J(["D1", "O-d0", "W-d0", "X2", "X3", "Y1", "Z2"]) ? null : `Recently Cleaned holds ${J(r.list)}`, tabIs(s, "X1", { win: ctx.W, active: true }), tabIs(s, "Z1", { win: ctx.O, active: true })],
});
// The daily clock: not due within a day, due again after one (the recorded time moves with the clock hook).
cuCase("CU.daily-due-decision", {
  act: async () => {
    const out = {};
    out.toggled = await dropdownItem(ctx.W, "Clean Up Daily"); out.heard = await waitFor(() => h.ev(`window.__vm.settings.get("cleanupDaily")`, ctx.H), 4000, 100);
    await h.ev(`window.__vm.store.set("lastCleanup", ${ctx.frozen - 23 * 3600 * 1000}).then(() => 1)`, ctx.H);
    out.at23h = await h.ev(`window.__vm.cleanup.tick()`, ctx.H);
    await h.ev(`window.__vm.store.set("lastCleanup", ${ctx.frozen - 24 * 3600 * 1000}).then(() => 1)`, ctx.H);
    out.at24h = await h.ev(`window.__vm.cleanup.tick()`, ctx.H);
    return out;
  },
  expect: (s, b, r) => [r.toggled === "ok" && r.heard === true ? null : `toggle: ${J([r.toggled, r.heard])}`, r.at23h === "not due" ? null : `23 h after: ${J(r.at23h)}`, r.at24h === 7 ? null : `24 h after: ${J(r.at24h)}, want 7 tabs`],
});

// ---------- Task 8n data-safety fixes ----------
// A confirm menu pushed so that its red row sits under the pointer: a double-click (second click at the same spot, within
// 400 ms) still does not confirm. The menu is moved on purpose (what the window-bottom clamp does) so the test does not
// depend on the window size.
const dangerUnderPointer = async (win, p) => h.ev(`(() => { const m = document.querySelector(${J(NT_MENU)}); const d = m.querySelector(".vm-menu-item.danger"); const dy = d.getBoundingClientRect(); const my = m.getBoundingClientRect();
  m.style.top = (parseFloat(m.style.top) + (${p.y} - (dy.top + dy.height / 2))) + "px"; m.style.left = (parseFloat(m.style.left) + (${p.x} - (dy.left + 20))) + "px";
  const e = document.elementFromPoint(${p.x}, ${p.y}); return !!e && !!e.closest(".vm-menu-item.danger"); })()`, win);
ntCase("N.close-all-doubleclick-bottom", {
  setup: SET_CLOSEALL,
  act: async () => {
    if (!(await openDropdown(ctx.W))) return { error: "no dropdown" };
    const p = await hoverOn(ctx.W, menuRow("Close All Tabs")); if (!p) return { error: "no row" };
    const count = () => h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.length)`, ctx.H);
    const before = await count();
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y);
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    const under = await dangerUnderPointer(ctx.W, p);
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y);
    await sleep(900);
    const stillOpen = await hasEl(ctx.W, ".vm-menu");
    // after the guard time, the same click confirms
    await sleep(500);
    const p2 = await hoverOn(ctx.W, `document.querySelector(".vm-menu .vm-menu-item.danger")`);
    await mouse(ctx.W, "mousePressed", p2.x, p2.y); await mouse(ctx.W, "mouseReleased", p2.x, p2.y); await sleep(1500);
    return { before, afterDouble: before, under, stillOpen, afterLate: await count() };
  },
  expect: (s, b, r) => [r.error ?? null, r.under ? null : "setup: the red row was not under the pointer, the test proves nothing", r.stillOpen ? null : "the ignored click closed the menu", r.afterLate < r.before ? null : "a later click did not confirm", ...(r.under ? [] : [])],
});
// The same for Clear list.
cuCase("CU.clear-list-doubleclick-bottom", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W); await sleep(900);
    if (!(await openDropdown(ctx.W)) || !(await openFly(ctx.W, "Recently Cleaned"))) return { error: "no flyout" };
    const p = await hoverOn(ctx.W, flyRow("Clear list"));
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y);
    await waitFor(() => rowsOf(ctx.W, NT_MENU + " > div").then((x) => (x.includes("Cancel") ? x : null)), 4000);
    const under = await dangerUnderPointer(ctx.W, p);
    await mouse(ctx.W, "mousePressed", p.x, p.y); await mouse(ctx.W, "mouseReleased", p.x, p.y); await sleep(800);
    return { under, listed: (await cleanedList(ctx.W)).length, stillOpen: await hasEl(ctx.W, ".vm-menu") };
  },
  expect: (s, b, r) => [r.error ?? null, r.under ? null : "setup: the red row was not under the pointer", r.listed === 2 ? null : `a double-click cleared the list (${r.listed} left, want 2)`, r.stillOpen ? null : "the ignored click closed the menu"],
});
// A run over the list's cap: only tabs whose entry is in the list close; the rest stay open.
cuCase("CU.over-the-cap", {
  setup: async () => {
    await SET_CU();
    // 205 more idle tabs in X, made in chunks (the sidebar re-renders on each; a single burst jams the window's UI)
    for (let i = 0; i < 205; i += 25) {
      await h.cdp(ctx.H).eval(`Promise.all(Array.from({ length: ${Math.min(25, 205 - i)} }, (_, k) => chrome.tabs.create({ windowId: ${ctx.W}, url: "data:text/html,<title>B" + (${i} + k) + "</title>B", active: false, vivExtData: JSON.stringify({ workspaceId: ${sp("X")} }) }))).then((t) => t.length)`, 60000);
      await sleep(400);
    }
    await waitFor(() => h.cdp(ctx.W).eval("1", 20000), 120000, 1000);
    await sleep(4500);
    ctx.frozen = Date.now();
    for (const w of [ctx.H, ctx.W, ctx.O]) await h.cdp(w).eval(`(window.__vm.cleanup.test = { idleMs: ${IDLE}, now: () => ${ctx.frozen} }, 1)`, 60000);
    await focus(ctx.W);
  },
  act: async () => {
    const r = await h.cdp(ctx.W).eval(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => ({ count: r.count, capped: r.capped, tried: r.tried, failed: r.failed }))`, 120000);
    await sleep(3000);
    const list = await h.cdp(ctx.W).eval(`window.__vm.cleanup.list().then((l) => l.map((e) => e.url))`, 60000);
    const open = await h.ev(`chrome.tabs.query({ windowId: ${ctx.W} }).then((t) => t.map((x) => x.url))`, ctx.H);
    const isCand = (u) => /<title>(B\d+|X2|X3|X4)</.test(decodeURIComponent(u));
    return { r, listLen: list.length, listedAndOpen: list.filter((u) => open.includes(u)).length, openCandidates: open.filter(isCand).length };
  },
  expect: (s, b, r) => [r.r.tried === 208 && r.r.count === 200 && r.r.capped === 8 ? null : `run ${J(r.r)}, want tried 208, closed 200, capped 8`, r.listLen === 200 ? null : `list holds ${r.listLen}`,
    r.listedAndOpen === 0 ? null : `${r.listedAndOpen} listed tabs are still open`, r.openCandidates === 8 ? null : `${r.openCandidates} candidates stayed open, want 8 (every closed tab has an entry: 208 - 200)`],
});
// store.set resolves without writing (what 00-core does on an error): nothing closes, the toast says so.
cuCase("CU.store-write-fails-silently", {
  act: async () => {
    await h.ev(`(() => { window.__realSet = window.__vm.store.set; window.__vm.store.set = (k, v) => (k === "cleaned" ? Promise.resolve() : window.__realSet(k, v)); return 1; })()`, ctx.W);
    try { const r = await cleanUpFromMenu(); if (r !== "ok") return { error: r }; const toast = await waitFor(() => toastNow(ctx.W), 6000, 100); await sleep(600); return { toast }; }
    finally { await h.ev(`(window.__realSet && (window.__vm.store.set = window.__realSet), 1)`, ctx.W); }
  },
  expect: (s, b, r) => [r.toast === "Could not clean up the tabs" ? null : `toast ${J(r.toast)}`, unchanged(b, s)],
});
// store.set never settles: the run gives up after its timeout, closes nothing, and later list changes still work.
cuCase("CU.store-write-hangs", {
  act: async () => {
    await h.ev(`(() => { window.__realSet = window.__vm.store.set; window.__vm.store.set = (k, v) => (k === "cleaned" ? new Promise(() => {}) : window.__realSet(k, v)); return 1; })()`, ctx.W);
    const t0 = Date.now(); let first;
    try { first = await h.cdp(ctx.W).eval(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => ({ count: r.count, failed: r.failed }))`, 60000); }
    finally { await h.ev(`(window.__realSet && (window.__vm.store.set = window.__realSet), 1)`, ctx.W); }
    const took = Date.now() - t0;
    const second = await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => ({ count: r.count, failed: r.failed }))`, ctx.W);
    await sleep(800);
    return { first, took, second, list: (await cleanedList(ctx.W)).length };
  },
  expect: (s, b, r) => [r.first?.count === 0 && r.first?.failed ? null : `hung write: ${J(r.first)}`, r.took >= 11500 && r.took < 22000 ? null : `gave up after ${r.took} ms`, r.second?.count === 2 ? null : `the run after it: ${J(r.second)} (the queue stayed jammed?)`, r.list === 2 ? null : `list ${r.list}`, ...gone(s, "X2", "X3")],
});
// A tab that became active between the write and the close stays, and its entry is taken back out.
cuCase("CU.tab-changed-in-the-gap", {
  act: async () => {
    await h.ev(`(() => { window.__realSet = window.__vm.store.set; window.__vm.store.set = async (k, v) => { if (k === "cleaned" && v.length) await chrome.tabs.update(${ctx.tabs.X2}, { active: true }); return window.__realSet(k, v); }; return 1; })()`, ctx.W);
    let r;
    try { r = await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W); }
    finally { await h.ev(`(window.__realSet && (window.__vm.store.set = window.__realSet), 1)`, ctx.W); }
    await sleep(1200);
    return { r, list: (await cleanedList(ctx.W)).map((e) => e.title) };
  },
  expect: (s, b, r) => [r.r === 1 ? null : `closed ${r.r}, want only X3`, ...kept(s, "X2"), ...gone(s, "X3"), J(r.list) === J(["X3"]) ? null : `list ${J(r.list)}, want just X3`],
});
// Two windows clean at once: both runs' entries survive (list changes are serialised across windows).
cuCase("CU.concurrent-runs", {
  act: async () => {
    await Promise.all([h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W), h.ev(`window.__vm.cleanup.run({ win: ${ctx.O}, space: ${sp("Z")} }).then((r) => r.count)`, ctx.O)]);
    await sleep(900);
    return { list: (await cleanedList(ctx.H)).map((e) => e.title).sort() };
  },
  expect: (s, b, r) => [J(r.list) === J(["X2", "X3", "Z2"]) ? null : `list ${J(r.list)}, want X2 X3 Z2`],
});
// A private window's tab is never cleaned or stored, and the private window never runs the daily clean. A private window
// is made with Vivaldi's own windowPrivate.create (chrome.windows.create returns null for it); its UI is a window.html of its
// own, with its own store. The normal windows cannot see it, so it is checked from inside.
cuCase("CU.private-window", {
  act: async () => {
    const pid = await h.ev(`new Promise((r) => vivaldi.windowPrivate.create({ incognito: true, focused: true }, (w) => r(w)))`, ctx.H);
    if (typeof pid !== "number") return { error: `no private window: ${J(pid)}` };
    try {
      await h.waitForWin(pid); await sleep(2500);
      const ev = (expr) => h.cdp(pid).eval(expr, 30000);
      const inc = await ev(`chrome.windows.getCurrent().then((w) => w.incognito)`);
      const a = await ev(`chrome.tabs.create({ url: "data:text/html,<title>PRIV2</title>PRIV2", active: false }).then((t) => t.id)`);
      await sleep(3500);
      await ev(`(window.__vm.cleanup.test = { idleMs: 2500, now: () => Date.now() }, 1)`);
      await ev(`window.__vm.settings.set("cleanupDaily", true)`); await sleep(500);
      const tick = await ev(`window.__vm.cleanup.tick()`);
      const run = await ev(`window.__vm.cleanup.run({}).then((r) => ({ count: r.count, tried: r.tried }))`);
      await sleep(800);
      const alive = await ev(`chrome.tabs.get(${a}).then(() => true, () => false)`);
      const stored = await ev(`window.__vm.store.get("cleaned", []).then((l) => l.length)`);
      const normalStored = (await cleanedList(ctx.H)).map((e) => e.title);
      return { inc, tick, run, alive, stored, normalStored };
    } finally { await h.cdp(pid).eval(`chrome.windows.getAll().then((a) => Promise.all(a.map((w) => chrome.windows.remove(w.id).catch(() => 0))))`, 20000).catch(() => {}); await sleep(1500); await h.refresh(); }
  },
  expect: (s, b, r) => [r.error ?? null, r.inc === true ? null : "the window was not private", r.tick === "private" ? null : `the private window's tick said ${J(r.tick)}`,
    r.run?.count === 0 && r.run?.tried === 0 ? null : `a manual run in the private window: ${J(r.run)}`, r.alive ? null : "the private tab was closed", r.stored === 0 ? null : `${r.stored} entries in the private store`,
    r.normalStored?.some((t) => /PRIV/.test(t)) ? "a private tab reached the normal store" : null],
});
// A tab shown beside the active one in a split view is on screen: never cleaned.
cuCase("CU.split-view-partner", {
  act: async () => {
    const tiling = JSON.stringify({ id: "t-sbx", layout: "row", type: "tile", index: 0 });
    await h.ev(`Promise.all([${ctx.tabs.X1}, ${ctx.tabs.X2}].map((id, i) => chrome.tabs.get(id).then((t) => { const d = JSON.parse(t.vivExtData || "{}"); d.tiling = { id: "t-sbx", layout: "row", type: "tile", index: i }; return chrome.tabs.update(id, { vivExtData: JSON.stringify(d) }); }))).then(() => 1)`, ctx.H);
    await sleep(600);
    const kept = await h.ev(`chrome.tabs.get(${ctx.tabs.X2}).then((t) => JSON.parse(t.vivExtData || "{}").tiling?.id || null)`, ctx.H);
    const n = await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W);
    await sleep(900);
    return { kept, n };
  },
  expect: (s, b, r) => [r.kept === "t-sbx" ? null : `setup: Vivaldi dropped the tiling (${J(r.kept)}), the case proves nothing`, ...kept(s, "X1", "X2"), ...gone(s, "X3"), r.n === 1 ? null : `closed ${r.n}, want only X3`],
});

// A failed READ of the list must not look like an empty list: nothing writes over the real one, and nothing closes.
// The read is made to fail both ways the old code was exposed to: store.read rejects, and store.get resolves its fallback
// (what a failed get does), so the case also breaks the pre-fix code.
cuCase("CU.read-fails-keeps-the-list", {
  act: async () => {
    await h.ev(`window.__vm.cleanup.run({ win: ${ctx.W}, space: ${sp("X")} }).then((r) => r.count)`, ctx.W); await sleep(900);
    const before = await cleanedList(ctx.W);
    const entries = await h.ev(`window.__vm.cleanup.list()`, ctx.W);
    const brk = () => h.ev(`(() => { const s = window.__vm.store; window.__real = { read: s.read, get: s.get }; s.read = () => Promise.reject(new Error("read failed")); s.get = (k, fb) => Promise.resolve(fb); return 1; })()`, ctx.W);
    const fix = () => h.ev(`(() => { const s = window.__vm.store; if (window.__real) { s.read = window.__real.read; s.get = window.__real.get; } return 1; })()`, ctx.W);
    const out = { before: before.map((e) => e.title).sort() };
    try {
      await brk();
      out.run = await h.ev(`window.__vm.cleanup.run({ win: ${ctx.O}, space: ${sp("Z")} }).then((r) => ({ count: r.count, failed: r.failed }))`, ctx.W);
      out.reopen = await h.ev(`window.__vm.cleanup.reopenOne(${J(entries.find((e) => e.title === "X2"))})`, ctx.W);
      await h.ev(`window.__vm.cleanup.undo([${J(entries.find((e) => e.title === "X3"))}]).then(() => 1)`, ctx.W);
    } finally { await fix(); }
    await sleep(1200);
    out.after = (await cleanedList(ctx.W)).map((e) => e.title).sort();
    return out;
  },
  expect: (s, b, r) => [J(r.before) === J(["X2", "X3"]) ? null : `setup: list ${J(r.before)}`, r.run?.count === 0 && r.run?.failed ? null : `run with a failed read: ${J(r.run)}`, ...kept(s, "Z2"),
    J(r.after) === J(["X2", "X3"]) ? null : `the list after failed reads: ${J(r.after)} (earlier entries lost?)`],
});

// Task 8o: a tab switch must not pop Vivaldi's hidden address field open. Vivaldi remembers per tab where the cursor was; a
// tab left with it in the address field re-focuses the field on every return, which Vivarc keeps collapsed. The tab is
// made to remember "addressfield" the way Vivaldi's own Ctrl+L does it: the field takes focus on it, and the tab is
// switched away from. Both layouts.
const afState = (win) => h.ev(`(() => { const f = document.querySelector(".toolbar-mainbar #urlFieldInput") || document.getElementById("urlFieldInput");
  const af = document.querySelector(".UrlBar-AddressField"); const r = af && af.getBoundingClientRect(); const a = document.activeElement;
  return { fieldFocused: !!f && a === f, value: f ? f.value : null, afH: r ? Math.round(r.height) : null, active: a ? a.tagName : null, bar: !!document.getElementById("vm-cmd"),
    barFocused: !!a && !!document.querySelector("#vm-cmd input") && a === document.querySelector("#vm-cmd input") }; })()`, win);
const afFocusField = (win) => h.ev(`((document.querySelector(".toolbar-mainbar #urlFieldInput") || document.getElementById("urlFieldInput")).focus(), 1)`, win);
const afSetup = async () => {
  await mkWin("W", { width: 1100 });
  await tab(ctx.W, "AFA", null, { active: true }); await tab(ctx.W, "AFB", null);
  await sleep(1200); await focus(ctx.W); await sleep(600);
};
const afLeaveAfield = async () => { // AFA remembers "addressfield", AFB is on screen
  await activate(ctx.tabs.AFA); await sleep(600);
  await afFocusField(ctx.W); await sleep(300);
  await activate(ctx.tabs.AFB); await sleep(700);
};
const afQuiet = (r, what) => [r.fieldFocused ? `${what}: the field has the cursor` : null, r.afH === 0 ? null : `${what}: the field is ${r.afH}px tall (floated open)`, r.active === "WEBVIEW" ? null : `${what}: focus is on ${r.active}, not the page`];
for (const layout of ["dia", "arc"]) {
  def(`AF.tab-switch-keeps-field-collapsed-${layout}`, {
    layout, setup: afSetup,
    act: async () => {
      await afLeaveAfield();
      await activate(ctx.tabs.AFA); await sleep(600);
      const first = await afState(ctx.W);
      await activate(ctx.tabs.AFB); await sleep(600); await activate(ctx.tabs.AFA); await sleep(600);
      return { first, second: await afState(ctx.W) };
    },
    expect: (s, b, r) => [...afQuiet(r.first, "switching back to the tab that remembered the field"), ...afQuiet(r.second, "switching away and back again")],
  });
  def(`AF.ctrl-l-floats-and-takes-typing-${layout}`, {
    layout, setup: afSetup,
    act: async () => {
      await activate(ctx.tabs.AFA); await sleep(800); // a quiet tab: no switch within 150 ms of the focus
      await afFocusField(ctx.W); await sleep(300);
      const floated = await afState(ctx.W);
      await h.cdp(ctx.W).send("Input.insertText", { text: "typed-after-ctrl-l" }); await sleep(200);
      return { floated, typed: await afState(ctx.W) };
    },
    expect: (s, b, r) => [r.floated.fieldFocused && r.floated.afH > 0 ? null : `the field did not float on focus: ${J(r.floated)}`, String(r.typed.value).includes("typed-after-ctrl-l") ? null : `typing did not reach the field: ${J(r.typed.value)}`],
  });
  def(`AF.typed-text-survives-a-switch-${layout}`, {
    layout, setup: afSetup,
    act: async () => {
      await activate(ctx.tabs.AFA); await sleep(600);
      await afFocusField(ctx.W); await sleep(300);
      await h.cdp(ctx.W).send("Input.insertText", { text: "my-typed-draft" }); await sleep(250);
      await activate(ctx.tabs.AFB); await sleep(700); await activate(ctx.tabs.AFA); await sleep(600);
      return afState(ctx.W);
    },
    expect: (s, b, r) => [String(r.value).includes("my-typed-draft") ? null : `the typed text is gone: ${J(r.value)}`, r.fieldFocused ? null : "Vivaldi's behaviour was not left alone: the field no longer has the cursor"],
  });
  def(`AF.popup-in-the-field-is-left-alone-${layout}`, {
    layout, setup: afSetup,
    act: async () => {
      await afLeaveAfield();
      await h.ev(`(() => { const d = document.createElement("div"); d.className = "addressfield-popup-container"; d.id = "af-fake-popup"; document.querySelector(".UrlBar-AddressField").append(d); return 1; })()`, ctx.W);
      await activate(ctx.tabs.AFA); await sleep(600);
      const r = await afState(ctx.W);
      await h.ev(`(document.getElementById("af-fake-popup")?.remove(), 1)`, ctx.W);
      return r;
    },
    expect: (s, b, r) => [r.fieldFocused && r.afH > 0 ? null : `a popup in the field did not keep it: ${J(r)}`],
  });
  def(`AF.a-new-tab-still-opens-the-command-bar-${layout}`, {
    layout, setup: afSetup,
    act: async () => {
      await waitFor(() => h.ev(`performance.now() > 6000`, ctx.W), 12000); // the bar ignores new tabs in a window's first 5 s
      await h.ev(`chrome.tabs.create({ windowId: ${ctx.W} }).then((t) => t.id)`, ctx.H);
      await sleep(900);
      return afState(ctx.W);
    },
    expect: (s, b, r) => [r.bar && r.barFocused ? null : `the command bar did not open with the cursor: ${J(r)}`, r.afH === 0 && !r.fieldFocused ? null : `Vivaldi's field floated over the bar: ${J(r)}`],
  });
}

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

// The acts' own reports: a string act ("clicked", "ok", "dropped", or what went wrong) and the menus' { error }.
// Acts that return data (dots, counts, the Dia button's state) are judged by their case's expect.
const ACTED = new Set(["clicked", "ok", "dropped"]);
const actFailure = (r) => typeof r === "string" ? (ACTED.has(r) ? null : `the act did not happen: ${r}`)
  : r && typeof r === "object" && !Array.isArray(r) && r.error ? `the act did not happen: ${r.error}` : null;

async function runCase(c, layout) {
  const t0 = Date.now();
  const out = { id: c.id, layout };
  try {
    const r0 = await reset();
    if (!r0.clean) throw new Error(`reset not clean: ${r0.why}`);
    await busy();
    await mkSpaces();
    await c.setup();
    if (ctx.W && (await layoutIn(ctx.W)) !== (layout === "dia")) throw new Error(`W is not in the ${layout} layout`);
    if (!(c.ready ? await c.ready() : ctx.W ? await waitTile(ctx.W, "X") : true)) throw new Error("setup never got ready (the tile, row or button it waits for did not appear)");
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
    // An act that did not happen fails the case, whatever the snapshot says: "nothing changed" must not pass by default.
    const notActed = c.clicks ? (result === "clicked" ? null : `the click did not happen: ${J(result)}`) : actFailure(result);
    const bad = [...(notActed ? [notActed] : []), ...invariants(after).map((v) => `invariant: ${v}`), ...(await c.expect(after, before, result)).filter(Boolean)];
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
  if (on !== (layout === "dia")) {
    console.log(`FAIL ${layout} layout: could not set it (vm-dia ${on}), none of its cases ran`);
    results.push({ id: "layout", layout, pass: false });
    continue;
  }
  // Arc: the tile rows (gesture table and dots) and the button's absence; Dia: everything that is not Arc-only.
  const set = C.filter((c) => (c.layout ? c.layout === layout : layout === "dia" || c.gesture))
    .filter((c) => !ONLY.length || ONLY.some((p) => c.id.startsWith(p)));
  if (!set.length) console.log(`${layout}: no case matches --only ${ONLY.join(",")}`);
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
// Success needs at least one case run and every one passed: a skipped layout or an --only that matched nothing fails.
const ran = results.filter((r) => !r.alias && r.id !== "layout").length;
if (!ran) console.log("FAIL no case ran");
process.exit(ran && results.every((r) => r.pass) ? 0 : 1);
