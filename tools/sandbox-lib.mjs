// CDP helpers for the sandbox Vivaldi that tools/sandbox.ps1 launches. Port 9333 only: these helpers refuse any
// other port, so they can never reach a Vivaldi running on its own profile (9222 or otherwise).
//
//   import { Harness } from "../tools/sandbox-lib.mjs";
//   const h = new Harness(); await h.refresh();          // one connection per window's UI (window.html)
//   const rec = await h.record();                         // Vivaldi's record: { all: [[space, window]], perWin }
//   await h.switchTo(win, space);                         // Vivaldi's own setActiveWorkspace
//   const s = await h.stable();                           // snapshot once nothing has changed for 1 s
export const PORT = 9333;

const checkPort = (url) => {
  const port = Number(new URL(url).port);
  if (PORT !== 9333 || port !== 9333) throw new Error(`sandbox-lib talks to port 9333 only, refused ${url}`);
  return url;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function targets() {
  return (await fetch(checkPort(`http://127.0.0.1:${PORT}/json/list`))).json();
}

// Vivaldi's browser UI: one window.html page target per window.
export async function uiTargets() {
  return (await targets()).filter((t) => t.url.includes("window.html"));
}

export class Cdp {
  static open(wsUrl) {
    checkPort(wsUrl.replace(/^ws/, "http"));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const c = new Cdp(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = () => reject(new Error("ws error " + wsUrl));
    });
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.closed = false;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("closed"));
      this.pending.clear();
    };
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeoutMs = 15000) {
    const p = this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs).then(() => { throw new Error("eval timeout: " + expr.slice(0, 80)); })]);
    if (r.exceptionDetails) throw new Error("eval exception: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

// Installed once per window.html: finds Vivaldi's workspace store in its webpack chunks (they live on the background
// page) and exposes window.__sbx = { sw, ws, mgr, pages, snap }.
//   sw.setActiveWorkspace(win, space)  ws.getActiveWorkspaces() / ws.getActiveWorkspaceId(win)  mgr.addWorkspaceWithId
export const HELPER = String.raw`(() => {
  if (window.__sbx) return window.__sbx.found;
  const bg = chrome.extension.getBackgroundPage();
  let load; bg.webpackChunkgapp_browser_react.push([[Symbol("sbx")], {}, (r) => { load = r; }]);
  const find = (marker, method) => {
    for (const [id, f] of Object.entries(load.m)) {
      if (!String(f).includes(marker)) continue;
      let mod; try { mod = load(id); } catch (_) { continue; }
      for (const v of Object.values(mod || {})) if (v && typeof v[method] === "function") return v;
    }
    return null;
  };
  const sw = find("setActiveWorkspace", "setActiveWorkspace");
  const ws = find("getActiveWorkspaceId(e){", "getActiveWorkspaces");
  const mgr = find('actionType:"CREATE_WORKSPACE"', "addWorkspaceWithId");
  const pages = find("getWorkspaceWindowId(e){", "getWorkspacePages");
  const wsOf = (t) => { try { const d = JSON.parse(t.vivExtData || "{}"); return "workspaceId" in d ? d.workspaceId : null; } catch (_) { return "bad"; } };
  const record = async () => {
    const wins = await chrome.windows.getAll();
    const perWin = {};
    for (const w of wins) { const a = ws.getActiveWorkspaceId(w.id); perWin[w.id] = a === undefined ? null : a; }
    return { all: [...ws.getActiveWorkspaces()].map(([k, v]) => [k ?? null, v]), perWin };
  };
  const snap = async () => {
    const wins = await chrome.windows.getAll({ populate: true });
    const lf = await chrome.windows.getLastFocused().catch(() => null);
    return {
      t: Date.now(), lastFocused: lf?.id ?? null, ...(await record()),
      wins: wins.map((w) => ({ id: w.id, type: w.type, focused: w.focused,
        tabs: w.tabs.map((t) => ({ id: t.id, index: t.index, active: t.active, pinned: t.pinned, ws: wsOf(t),
          url: (t.pendingUrl || t.url || "").slice(0, 90), title: (t.title || "").slice(0, 40) })) })),
      spaces: (ws.getWorkspaces ? ws.getWorkspaces() : []).map((x) => [x.id, x.name]),
    };
  };
  window.__sbx = { sw, ws, mgr, pages, wsOf, record, snap, found: { sw: !!sw, ws: !!ws, mgr: !!mgr, pages: !!pages } };
  return window.__sbx.found;
})()`;

// One CDP connection per window's UI, keyed by window id.
export class Harness {
  constructor() { this.byWin = new Map(); this.byTarget = new Map(); }
  async refresh() {
    const ts = await uiTargets();
    const live = new Set(ts.map((t) => t.id));
    for (const [tid, e] of this.byTarget) if (!live.has(tid) || e.cdp.closed) { this.byTarget.delete(tid); this.byWin.delete(e.win); }
    for (const t of ts) {
      if (this.byTarget.has(t.id)) continue;
      try {
        const cdp = await Cdp.open(t.webSocketDebuggerUrl);
        const win = await cdp.eval("chrome.windows.getCurrent().then(w => w.id)", 5000);
        await cdp.eval(HELPER, 10000);
        const e = { cdp, win, target: t.id };
        this.byTarget.set(t.id, e); this.byWin.set(win, e);
      } catch (_) { /* still loading: picked up on the next refresh */ }
    }
    return [...this.byWin.keys()];
  }
  async waitForWin(id, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { await this.refresh(); if (this.byWin.has(id)) return this.byWin.get(id); await sleep(200); }
    throw new Error("no UI target for window " + id);
  }
  cdp(win) { const e = this.byWin.get(win); if (!e) throw new Error("no UI connection for window " + win); return e.cdp; }
  // Evaluate in a window's UI (any window when win is omitted).
  async ev(expr, win) {
    if (win == null) { await this.refresh(); win = this.driver ?? Math.min(...this.byWin.keys()); }
    return this.cdp(win).eval(expr);
  }
  record(win) { return this.ev("window.__sbx.record()", win); }
  snap(win) { return this.ev("window.__sbx.snap()", win); }
  switchTo(win, space, from) {
    const s = space === undefined || space === null ? "undefined" : JSON.stringify(space);
    return this.ev(`window.__sbx.sw.setActiveWorkspace(${win}, ${s}).then(() => "ok", e => "err:" + e)`, from ?? win);
  }
  // Poll every 150 ms until the snapshot is unchanged for quietMs (cap capMs).
  async stable(win, { quietMs = 1000, capMs = 10000 } = {}) {
    const start = Date.now(); let last = null, key = null, since = Date.now();
    while (true) {
      let s; try { s = await this.snap(win); } catch (_) { await this.refresh(); s = await this.snap(); }
      const k = canon(s);
      if (k !== key) { key = k; since = Date.now(); }
      last = s;
      if (Date.now() - since >= quietMs) return { ...last, settledMs: since - start, capped: false };
      if (Date.now() - start >= capMs) return { ...last, settledMs: null, capped: true };
      await sleep(150);
    }
  }
  close() { for (const e of this.byTarget.values()) e.cdp.close(); }
}

export function canon(s) {
  return JSON.stringify({
    w: s.wins.map((w) => [w.id, w.focused, w.tabs.map((t) => [t.id, t.index, t.active, t.ws])]),
    r: s.all, p: s.perWin, f: s.lastFocused,
  });
}

export const tabUrl = (label) => `data:text/html,<title>${label}</title>${label}`;
