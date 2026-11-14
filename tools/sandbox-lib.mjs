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
  // A reply that never comes (a connection gone quiet without closing: task 8v's final Dia sweep waited 15 minutes on
  // one) rejects after `deadlineMs` (90 s unless the caller waits longer itself), so a case fails instead of the sweep
  // stalling for good.
  send(method, params = {}, deadlineMs = 90000) {
    if (this.closed) return Promise.reject(new Error("closed"));
    const release = this.track(method, params);
    const id = ++this.id;
    const sent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`no reply to ${method} in ${Math.round(deadlineMs / 1000)} s`)); }, deadlineMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    // A release counts only once it is acknowledged: until then (and after a failure) the button or key stays held here,
    // so releaseAll() tries it again and says so (review round 2).
    if (release) sent.then(() => release.ack(), (error) => release.fail(error));
    return sent;
  }
  // What this connection holds down (Task 9b fix rounds 1-2): a mouse button pressed, a key (or a modifier) down, kept until
  // its release is acknowledged. Recorded as it is SENT, so a press whose reply never comes (the input-ack hang, task 8v)
  // still counts as held. -> for a release, { ack, fail } to settle it.
  track(method, params) {
    this.held ??= { buttons: new Map(), keys: new Map(), failed: [] };
    if (method === "Input.dispatchMouseEvent") {
      const b = params.button || "left";
      if (params.type === "mousePressed") this.held.buttons.set(b, { x: params.x, y: params.y, releasing: false });
      else if (params.type === "mouseReleased") {
        const entry = this.held.buttons.get(b);
        if (!entry) return null;
        entry.releasing = true;
        return { ack: () => { if (this.held.buttons.get(b) === entry) this.held.buttons.delete(b); },
          fail: (error) => { entry.releasing = false; this.held.failed.push({ button: b, error: String(error?.message || error) }); } };
      }
    } else if (method === "Input.dispatchKeyEvent") {
      const k = `${params.code || params.key}`;
      if (params.type === "keyDown" || params.type === "rawKeyDown") this.held.keys.set(k, { key: params.key, code: params.code, windowsVirtualKeyCode: params.windowsVirtualKeyCode, nativeVirtualKeyCode: params.nativeVirtualKeyCode, releasing: false });
      else if (params.type === "keyUp") {
        const entry = this.held.keys.get(k);
        if (!entry) return null;
        entry.releasing = true;
        return { ack: () => { if (this.held.keys.get(k) === entry) this.held.keys.delete(k); },
          fail: (error) => { entry.releasing = false; this.held.failed.push({ key: k, error: String(error?.message || error) }); } };
      }
    }
    return null;
  }
  heldNow() { return { buttons: [...(this.held?.buttons.keys() || [])], keys: [...(this.held?.keys.keys() || [])] }; }
  // Lets go of everything still held (a release never sent, or one not acknowledged), each with a bounded deadline and up to
  // `tries` attempts. -> { held: what was held, failed: releases that failed since the last call, left: what is still held }.
  async releaseAll(deadlineMs = 5000, tries = 2) {
    if (!this.held || this.closed) return { held: this.heldNow(), failed: [], left: this.heldNow() };
    const held = this.heldNow();
    for (let attempt = 0; attempt < tries && (this.held.buttons.size || this.held.keys.size); attempt++) {
      for (const [button, at] of [...this.held.buttons]) {
        await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x ?? 0, y: at.y ?? 0, button, buttons: 0, clickCount: 1 }, deadlineMs).catch(() => {});
      }
      for (const [, key] of [...this.held.keys].reverse()) {
        const { releasing, ...ids } = key;
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...ids, modifiers: 0 }, deadlineMs).catch(() => {});
      }
    }
    const failed = this.held.failed.splice(0);
    return { held, failed, left: this.heldNow() };
  }
  // The reply's deadline is never shorter than the caller's own timeout (CU.over-the-cap evaluates for up to 120 s): the
  // eval's own timeout is the one that reports.
  async eval(expr, timeoutMs = 15000) {
    const p = this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, Math.max(90000, timeoutMs + 5000));
    const r = await Promise.race([p, sleep(timeoutMs).then(() => { throw new Error("eval timeout: " + expr.slice(0, 80)); })]);
    if (r.exceptionDetails) throw new Error("eval exception: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

// An expression (for a window.html evaluate) that is Vivaldi's webpack require, from the chunk array on the background
// page. The pushed entry is taken out again at once: webpack keeps it, and on the background page its function would be
// a reference into the window that pushed it after that window closes (task 8t fix1, as Vivarc's own requireOf in
// 07-workspaces.js; Vivaldi 8.3 keeps closed windows by itself too).
export const BG_REQUIRE = (tag) => String.raw`((a) => { let load; const e = [[Symbol(${JSON.stringify(tag)})], {}, (r) => { load = r; }]; a.push(e);
  const i = a.lastIndexOf(e); if (i >= 0) a.splice(i, 1); return load; })(chrome.extension.getBackgroundPage().webpackChunkgapp_browser_react)`;

// Installed once per window.html: finds Vivaldi's workspace store in its webpack chunks (they live on the background
// page) and exposes window.__sbx = { sw, ws, mgr, pages, snap }.
//   sw.setActiveWorkspace(win, space)  ws.getActiveWorkspaces() / ws.getActiveWorkspaceId(win)  mgr.addWorkspaceWithId
export const HELPER = String.raw`(() => {
  if (window.__sbx) return window.__sbx.found;
  const load = ${BG_REQUIRE("sbx")};
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
