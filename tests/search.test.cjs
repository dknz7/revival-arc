const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../src/js', name), 'utf8');
function setup({ incognito = false, missing = false, suggestUrl = 'https://chosen.test/suggest?q={searchTerms}' } = {}) {
  const calls = { fetch: [], request: [], navigation: [] };
  const normal = { guid: 'chosen', keyword: 'c', name: 'Chosen', url: 'https://chosen.test/?q={searchTerms}', suggestUrl };
  const privateEngine = { ...normal, guid: 'private', suggestUrl: 'https://private.test/suggest?q=%s' };
  const reply = { defaultSearch: missing ? 'missing' : 'chosen', defaultPrivate: 'private', templateUrls: [normal, privateEngine] };
  const context = vm.createContext({
    console: { log() {}, warn() {} }, AbortSignal, URL, navigator: { language: 'fr' },
    window: { __vm: {} },
    chrome: { windows: { getCurrent: async () => ({ incognito, type: "normal", focused: true, id: 1 }) }, tabs: {
      create: async opts => calls.navigation.push(opts), update: async (id, opts) => calls.navigation.push({ id, ...opts }),
      query: async () => [], onCreated: { addListener(fn) { calls.onCreated = fn; } }, onActivated: { addListener(fn) { calls.onActivated = fn; (calls.activatedAll ||= []).push(fn); } },
    }, bookmarks: { search: async () => [] }, history: { search: async () => [] } },
    vivaldi: { searchEngines: {
      getTemplateUrls: async () => reply,
      getSearchRequest: async (guid, query) => { calls.request.push({ guid, query }); return { url: `https://${guid}.test/?q=${encodeURIComponent(query)}` }; },
    } },
    fetch: async (url, options) => { calls.fetch.push({ url, options }); return { ok: true, json: async () => ['test', ['test result', ['invalid'], 'test other']] }; },
  });
  vm.runInContext(source('08-search.js'), context);
  return { context, calls, normal, reply, search: context.window.__vm.search };
}
test('uses Vivaldi default GUID and native expansion without chrome.search', async () => {
  const { search, calls } = setup();
  const engine = await search.defaultEngine();
  const request = await search.request(engine, 'été & café');
  assert.equal(request.url, 'https://chosen.test/?q=%C3%A9t%C3%A9%20%26%20caf%C3%A9');
  assert.equal(calls.request[0].guid, 'chosen');
});
test('private windows use the private default; changed defaults are read live', async () => {
  const { search, reply } = setup({ incognito: true });
  assert.equal((await search.defaultEngine()).guid, 'private');
  reply.defaultPrivate = 'chosen';
  assert.equal((await search.defaultEngine()).guid, 'chosen');
});
test('suggestions use the chosen engine and encode the query', async () => {
  const { search, calls } = setup();
  assert.deepEqual(Array.from(await search.suggestions(await search.defaultEngine(), 'été & café')), ['test result', 'test other']);
  assert.equal(calls.fetch[0].url, 'https://chosen.test/suggest?q=%C3%A9t%C3%A9%20%26%20caf%C3%A9');
  assert.equal(calls.fetch[0].options.credentials, 'omit');
});
test('missing Suggest URL makes no network request to another engine', async () => {
  const { search, calls } = setup({ suggestUrl: '' });
  assert.equal((await search.suggestions(await search.defaultEngine(), 'test')).length, 0);
  assert.equal(calls.fetch.length, 0);
});
test('unresolvable default fails explicitly instead of choosing DuckDuckGo', async () => {
  const { search, calls } = setup({ missing: true });
  await assert.rejects(search.defaultEngine(), /default search engine/);
  assert.equal(calls.fetch.length, 0);
});
test('parses OpenSearch and phrase objects and rejects unknown required templates', () => {
  const { search } = setup();
  assert.deepEqual(Array.from(search.phrases([{ phrase: 'one' }, {}, { phrase: 'two' }])), ['one', 'two']);
  assert.equal(search.expand('https://test/?q=%s&encoding={inputEncoding}&optional={unused?}', 'a b'), 'https://test/?q=a%20b&encoding=UTF-8&optional=');
  assert.equal(search.expand('https://test/?q={searchTerms}&x={unknown}', 'test'), null);
});
async function loadBar(context, settingsOpen = false) {
  const nodes = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; this.style = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, fn) { this.events[name] = fn; }
    remove() {} focus() {} select() { this.selected = true; } scrollIntoView() {} querySelector() { return null; }
  }
  const browser = new Element('body');
  context.document = { body: browser, addEventListener() {}, querySelector: () => browser, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } };
  context.setTimeout = () => {};
  context.CustomEvent = class {};
  const events = context.events = {};
  Object.assign(context.window, { addEventListener: (name, fn) => events[name] = fn, dispatchEvent() {} });
  Object.assign(context.window.__vm, { config: {}, cssLoaded: true, settings: { get: () => true, isOpen: () => settingsOpen }, normalise: x => x, shortcut: x => x, onShortcut(fn) { (context.shortcutFns ||= []).push(fn); } });
  vm.runInContext(source('07-workspaces.js'), context);
  vm.runInContext(source('20-command-bar.js'), context);
  await events['vm-open-command-bar']();
  return nodes.find(node => node.tag === 'input');
}
test('Ctrl+T search and suggestion selection both navigate with the default engine', async () => {
  const { context, calls } = setup();
  const input = await loadBar(context);
  await new Promise(resolve => setImmediate(resolve));
  input.value = 'test query';
  await input.events.input();
  input.events.keydown({ key: 'ArrowDown', preventDefault() {} }); // first suggestion
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.fetch[0].url, 'https://chosen.test/suggest?q=test%20query');
  assert.equal(calls.request[0].guid, 'chosen');
  assert.equal(calls.request[0].query, 'test result');
  assert.equal(calls.navigation[0].url, 'https://chosen.test/?q=test%20result');
});

test('HTTP URL suggestions navigate directly instead of searching', async () => {
  // The address goes through the bar's resolver (Task 9b), as typed text does: the scheme comes back lower-case.
  for (const [url, opened] of [['https://www.diy.com/', 'https://www.diy.com/'], ['HTTP://example.test/path?q=one', 'http://example.test/path?q=one']]) {
    const { context, calls } = setup();
    context.fetch = async () => ({ ok: true, json: async () => ['diy', [url]] });
    const input = await loadBar(context);
    await new Promise(resolve => setImmediate(resolve));
    input.value = 'diy';
    await input.events.input();
    await press(input, 'ArrowDown');
    await press(input, 'Enter');
    assert.equal(calls.navigation[0].url, opened);
    assert.equal(calls.request.length, 0);
  }
});

test('a malformed http address offered as a suggestion stays a search phrase (merge of #108 and the resolver)', async () => {
  const { context, calls } = setup();
  context.fetch = async () => ({ ok: true, json: async () => ['diy', ['https://diy shop/']] });
  const input = await loadBar(context);
  await new Promise(resolve => setImmediate(resolve));
  input.value = 'diy';
  await input.events.input();
  await press(input, 'ArrowDown');
  await press(input, 'Enter');
  assert.ok(!calls.navigation.some((n) => /^https?:\/\/diy/i.test(n.url)), JSON.stringify(calls.navigation));
  assert.equal(calls.request[0].query, 'https://diy shop/');
});

test('domain-like suggestions remain search phrases', async () => {
  const { context, calls } = setup();
  context.fetch = async () => ({ ok: true, json: async () => ['diy', ['example.com']] });
  const input = await loadBar(context);
  await new Promise(resolve => setImmediate(resolve));
  input.value = 'diy';
  await input.events.input();
  await press(input, 'ArrowDown');
  await press(input, 'Enter');
  assert.equal(calls.request[0].query, 'example.com');
});

test('command bar stays closed while the Vivarc settings overlay is open', async () => {
  const { context, calls } = setup();
  assert.equal(await loadBar(context, true), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.navigation.length, 0);
  assert.equal(calls.fetch.length, 0);
});

for (const win of [
  { type: 'popup', focused: true },
  { type: 'normal', focused: true, vivExtData: '{"windowType":"settings"}' },
  { type: 'normal', focused: false },
]) {
  test(`command bar ignores non-main windows: ${JSON.stringify(win)}`, async () => {
    const { context } = setup();
    context.chrome.windows.getCurrent = async () => win;
    assert.equal(await loadBar(context), undefined);
  });
}

test('first blank tab of a new workspace never reactivates the previous workspace', async () => {
  const { context, calls } = setup();
  await loadBar(context);
  calls.onActivated({ tabId: 10 });
  context.chrome.tabs.get = async () => ({ id: 10, vivExtData: '{"workspaceId":1}' });
  context.Date = { now: () => Date.now() + 6000 };
  const scheduled = [];
  context.setTimeout = fn => scheduled.push(fn);
  await calls.onCreated({ id: 20, windowId: 1, active: true, url: 'vivaldi://newtab', vivExtData: '{"workspaceId":2}' });
  assert.equal(scheduled.length, 0, 'must not schedule reactivation of the old tab');
  assert.equal(calls.navigation.length, 0);
});

// A window whose bar was opened and closed again, then sees `tabs` (id -> tab) with tab 10 active in space 1.
async function spaces(tabs) {
  const { context, calls } = setup();
  (await loadBar(context)).events.keydown({ key: 'Escape', preventDefault() {} });
  vm.runInContext(source('07-workspaces.js'), context);
  const inputs = [], made = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); made.push(node); if (tag === 'input') inputs.push(node); return node; };
  context.Date = { now: () => Date.now() + 6000 };
  context.setTimeout = fn => fn();
  calls.removed = [];
  const active = { 1: 10 }; // window id -> its active tab
  Object.assign(context.chrome.tabs, {
    get: async id => tabs[id], remove: async id => calls.removed.push(id), duplicate: async id => calls.duplicated = id,
    query: async q => Object.values(tabs).filter(t => (!q.windowId || t.windowId === q.windowId) && (!q.active || t.id === active[t.windowId])),
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const activate = async (tabId, windowId = 1) => { active[windowId] = tabId; calls.onActivated({ tabId, windowId }); await settle(); };
  await activate(10);
  return { context, calls, inputs, made, activate };
}
const page = (id, space, windowId = 1) => ({ id, windowId, url: `https://${id}.test/`, vivExtData: `{"workspaceId":${space}}` });
const blank = (id, space, windowId = 1) => ({ id, windowId, url: 'vivaldi://newtab', vivExtData: `{"workspaceId":${space}}` });

test('landing in an empty space opens the bar on its blank tab, and Escape stays in the space', async () => {
  const { calls, inputs, activate } = await spaces({ 10: page(10, 1), 20: blank(20, 2) });
  await activate(20);
  assert.equal(inputs.length, 1, 'the bar opens');
  inputs[0].events.keydown({ key: 'Escape', preventDefault() {} });
  assert.deepEqual(calls.removed, [], "Escape must not close the space's only tab");
});
test('the bar stays shut for a space with pages, a tab in the same space, or a switch in another window', async () => {
  const { inputs, activate } = await spaces({ 10: page(10, 1), 11: blank(11, 1), 20: blank(20, 2), 21: page(21, 2), 30: page(30, 3, 2), 31: blank(31, 4, 2) });
  await activate(11);
  await activate(20);
  await activate(30, 2);
  await activate(31, 2);
  assert.equal(inputs.length, 0);
});
test('moving between blank tabs of one empty space does not reopen the bar', async () => {
  const { inputs, activate } = await spaces({ 10: page(10, 1), 20: blank(20, 2), 22: blank(22, 2) });
  await activate(20);
  inputs[0].events.keydown({ key: 'Escape', preventDefault() {} });
  await activate(22);
  assert.equal(inputs.length, 1);
});
test("a space switch in another window leaves this window's bar open", async () => {
  const { calls, inputs, activate } = await spaces({ 10: page(10, 1), 20: blank(20, 2), 30: page(30, 3, 2), 31: page(31, 4, 2) });
  await activate(20);
  await activate(30, 2);
  await activate(31, 2);
  inputs[0].value = 'example.test';
  await inputs[0].events.input();
  inputs[0].events.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(calls.navigation.at(-1), { id: 20, url: 'https://example.test', active: true }, 'the bar is still open on tab 20');
});
test('switching space closes a bar left open for the space before, keeping that space its tab', async () => {
  const { calls, inputs, activate } = await spaces({ 10: page(10, 1), 20: blank(20, 2), 30: blank(30, 3) });
  await activate(20);
  await activate(30);
  assert.equal(inputs.length, 2, 'the bar closes for space 2 and opens again for space 3');
  assert.deepEqual(calls.removed, []);
});
test("landing in a space whose only tab is Vivaldi's Bookmarks page leaves the bar shut", async () => {
  const bookmarks = { ...blank(20, 2), url: 'chrome://vivaldi-webui/startpage?section=bookmarks' };
  const { inputs, activate } = await spaces({ 10: page(10, 1), 20: bookmarks });
  await activate(20);
  assert.equal(inputs.length, 0);
});

// Clicking the sidebar's URL field fires vm-edit-url: the bar edits the current page (tab 10).
async function editUrl(tabs = { 10: page(10, 1), 11: page(11, 1) }) {
  const space = await spaces(tabs);
  // Vivaldi's list holds spaces 1 to 4 (Task 9a: with nothing typed, only tabs of listed spaces are offered); no switch
  space.context.window.__vm.native = { spaceIds: async () => [1, 2, 3, 4], hasSwitch: () => false, record: () => null };
  space.edit = async () => {
    await space.context.events['vm-edit-url']();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  };
  await space.edit();
  return space;
}
const press = async (input, key) => { input.events.keydown({ key, preventDefault() {} }); for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
test('clicking the URL opens the bar on the current page, its URL filled in and selected', async () => {
  const { inputs } = await editUrl();
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].value, 'https://10.test/');
  assert.equal(inputs[0].selected, true);
});
test('an edited URL loads in the current tab, not a new one', async () => {
  const { calls, inputs } = await editUrl();
  inputs[0].value = 'example.test';
  await inputs[0].events.input();
  await press(inputs[0], 'Enter');
  assert.deepEqual(calls.navigation.at(-1), { id: 10, url: 'https://example.test', active: true });
});
test('Escape, or switching to another tab from the bar, leaves the current page open', async () => {
  const { calls, inputs, edit } = await editUrl();
  await press(inputs[0], 'Escape');
  await edit();
  inputs[1].value = '';
  await inputs[1].events.input();
  await press(inputs[1], 'Enter'); // the first row: open tab 11
  assert.deepEqual(calls.navigation.at(-1), { id: 11, active: true });
  assert.deepEqual(calls.removed, []);
});
test("the bar's tab actions act on the page being edited", async () => {
  const { calls, inputs } = await editUrl();
  inputs[0].value = 'duplicate';
  await inputs[0].events.input();
  await press(inputs[0], 'ArrowDown'); // past the search row, to Duplicate Tab
  await press(inputs[0], 'Enter');
  assert.equal(calls.duplicated, 10);
});
test('a new tab taking over an edit bar drops the edited address, and actions act on the page again', async () => {
  const { calls, inputs } = await editUrl({ 10: page(10, 1), 11: page(11, 1), 20: blank(20, 1) });
  await calls.onCreated({ ...blank(20, 1), active: true });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(inputs.length, 1, 'the open bar is reused');
  assert.equal(inputs[0].value, '');
  inputs[0].value = 'duplicate';
  await inputs[0].events.input();
  await press(inputs[0], 'ArrowDown');
  await press(inputs[0], 'Enter');
  assert.equal(calls.duplicated, 10, 'not the blank tab behind the bar');
});
for (const url of ['file:///C:/Users/', 'about:blank', 'view-source:https://x.test/']) {
  test(`editing ${url} keeps it an address: no search, no suggestions sent`, async () => {
    const { calls, inputs, edit } = await editUrl({ 10: { ...page(10, 1), url } });
    await press(inputs[0], 'Enter');
    assert.deepEqual(calls.navigation.at(-1), { id: 10, url, active: true });
    await edit();
    const edited = `${url}x`;
    inputs[1].value = edited;
    await inputs[1].events.input();
    await press(inputs[1], 'Enter');
    assert.deepEqual(calls.navigation.at(-1), { id: 10, url: edited, active: true });
    assert.equal(calls.fetch.length, 0);
  });
}
test('the rest of a double click does not close the bar it opened; a later click away does', async () => {
  const { context, calls, inputs, made, edit } = await editUrl();
  const backdrop = () => made.filter(node => node.id === 'vm-cmd').at(-1);
  backdrop().events.mousedown({ target: backdrop() });
  await press(inputs[0], 'Enter');
  assert.deepEqual(calls.navigation.at(-1), { id: 10, url: 'https://10.test/', active: true }, 'the bar stayed open');
  await edit();
  context.Date = { now: () => Date.now() + 7000 };
  backdrop().events.mousedown({ target: backdrop() });
  const before = calls.navigation.length;
  await press(inputs[1], 'Enter');
  assert.equal(calls.navigation.length, before, 'the bar closed');
  assert.deepEqual(calls.removed, []);
});
test('switching tab in this window closes an edit bar, keeping its page; a switch in another window does not', async () => {
  const { calls, inputs, activate, edit } = await editUrl({ 10: page(10, 1), 11: page(11, 1), 30: page(30, 3, 2), 31: page(31, 3, 2) });
  await activate(31, 2);
  await press(inputs[0], 'Enter');
  assert.deepEqual(calls.navigation.at(-1), { id: 10, url: 'https://10.test/', active: true }, 'still open after a switch in window 2');
  await edit();
  await activate(11);
  const before = calls.navigation.length;
  await press(inputs[1], 'Enter');
  assert.equal(calls.navigation.length, before, 'closed by the switch to tab 11');
  assert.deepEqual(calls.removed, []);
});

// The bar edits tab 10 (window 1, recorded on `shown`) and Enter picks its first row, tab 20. Vivaldi's record and switch
// are faked; every switch, focus and activation lands in one log, in order.
// known: the spaces Vivaldi's list holds (Task 9a: a tab in a space not listed was deleted); null: the list can't be read.
// knownLater: what the list says from its second read on (a space deleted between the listing and the switch).
// typed: the text that finds tab 20, whose row is then clicked (the list with nothing typed holds only the space on screen
// here, Byron 2026-11-15, so a tab of another space or window is reached by typing); '' leaves the field empty and presses Enter.
async function pickTab(tabs, { shown = 1, all = [[1, 1]], record = true, hasSwitch = true, minimised = null, known = [1, 2], knownLater, via = 'pickTab', moveTo, raceAt, closeBefore, typed = '20.test' } = {}) {
  const space = await editUrl(tabs);
  const log = [];
  space.context.window.__vm.native = {
    record: () => (record ? { activeIn: (w) => (w === 1 ? shown : 0), all: () => new Map(all) } : null),
    hasSwitch: () => hasSwitch,
    // raceAt: on that read (0-based) the tab is replaced by itself in space 3 and space 2 leaves the list
    spaceIds: (() => { let n = 0; return async () => {
      const k = n++;
      if (raceAt !== undefined && k === raceAt) { tabs[20] = page(20, 3); log.push(['list-changed']); return [1, 3]; }
      return k === 0 || knownLater === undefined ? known : knownLater; }; })(),
    setSpace: async (id, s, opts) => { log.push(['setSpace', id, s, { ...opts }]); },
    switchTo: async (w, s) => { log.push(['switch', w, s]); },
    focus: async (w) => { log.push(['focus', w]); },
  };
  const update = space.context.chrome.tabs.update;
  space.context.chrome.tabs.update = async (id, opts) => { log.push(['update', id, { ...opts }]); return update(id, opts); };
  // minimised: the windows that are minimised; leave it null and chrome.windows has no get (the older tests' fake)
  if (minimised) {
    space.context.chrome.windows.get = async id => ({ id, state: minimised.includes(id) ? 'minimized' : 'normal' });
    space.context.chrome.windows.update = async (id, opts) => { log.push(['window', id, { ...opts }]); };
  }
  if (via === 'pickTab-direct') {
    await space.context.window.__vm.pickTab(tabs[20]);
    return { ...space, log };
  }
  if (via === 'restoreTab') {
    space.context.chrome.tabs.move = async (id, opts) => { log.push(['tabs.move', id, { ...opts }]); };
    await space.context.window.__vm.restoreTab(tabs[20]);
    return { ...space, log };
  }
  space.inputs[0].value = typed;
  await space.inputs[0].events.input();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  const row = typed ? tabRows(space.made).find((r) => r.label === 'https://20.test/') : null;
  if (typed) assert.ok(row, `typing ${typed} lists tab 20: ${JSON.stringify(tabRows(space.made).map((r) => r.label))}`);
  if (moveTo !== undefined) Object.assign(tabs[20], page(20, moveTo)); // the tab changes space after the bar listed it
  if (closeBefore) delete tabs[20]; // the tab closes after the bar listed it
  if (row) { row.node.events.click(); for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }
  else await press(space.inputs[0], 'Enter');
  return { ...space, log };
}
// The bar's rendered rows (the latest list): each row's label, the hint it shows, and its node (its click runs it).
const tabRows = (made) => {
  const list = made.filter((node) => node.className === 'vm-cmd-list').at(-1);
  return (list?.children || []).map((node) => ({ node, label: node.children.find((c) => c.className === 'vm-cmd-title')?.textContent,
    says: node.children.find((c) => c.className === 'vm-cmd-hint')?.children[0].textContent }));
};
test('a tab picked from the bar in a space parked in this window is shown by a switch first, then activated', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) });
  assert.deepEqual(log, [['switch', 1, 2], ['update', 20, { active: true }]]);
});
test('a tab picked from the bar in the space on screen is just activated', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 1) });
  assert.deepEqual(log, [['update', 20, { active: true }]]);
});
test("a tab picked from the bar whose space is shown in another window goes to that window, as a tile click does", async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { all: [[1, 1], [2, 2]] });
  assert.deepEqual(log, [['focus', 2]]);
});
test('a tab picked in another window that is minimised brings that window back to normal, then focuses it', async () => {
  const focused = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { all: [[1, 1], [2, 2]], minimised: [2] });
  assert.deepEqual(focused.log, [['window', 2, { state: 'normal', focused: true }], ['focus', 2]], 'its space is shown there');
  const activated = await pickTab({ 10: page(10, 1), 20: page(20, 0, 2) }, { all: [[1, 1]], minimised: [2] });
  assert.deepEqual(activated.log, [['update', 20, { active: true }], ['window', 2, { state: 'normal', focused: true }]]);
});
test('a tab picked in another window that is not minimised is only focused', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 0, 2) }, { all: [[1, 1]], minimised: [] });
  assert.deepEqual(log, [['update', 20, { active: true }], ['window', 2, { focused: true }]]);
});
// Task 9a (8y bug 1): a tab of a deleted space (9) is brought into the space on screen here, never switched to.
test('a tab picked from the bar whose space was deleted joins the space on screen and is activated, with no switch', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 9) }, { via: 'pickTab-direct' });
  assert.deepEqual(log, [['setSpace', 20, 1, { windowId: 1 }], ['update', 20, { active: true }]]);
});
test('a named space deleted between the listing and the switch is not switched to: the tab joins the space on screen', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { known: [1, 2], knownLater: [1] });
  assert.deepEqual(log, [['setSpace', 20, 1, { windowId: 1 }], ['update', 20, { active: true }]]);
});
// Task 9a fix round: a restored tab comes to the window clicked in (window 1 here, showing 1).
test('a restored tab of a space living in no other window keeps its space here: moved, the window switched, then shown', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { via: 'restoreTab' });
  assert.deepEqual(log, [['switch', 1, 2], ['update', 20, { active: true }]]);
});
test('a restored tab is not moved while the list cannot be read (only activated)', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 9) }, { via: 'restoreTab', known: null });
  assert.deepEqual(log, [['update', 20, { active: true }]]);
});
test('a restored tab of a deleted space joins the space on screen here, with no switch', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 9) }, { via: 'restoreTab' });
  assert.deepEqual(log, [['setSpace', 20, 1, { windowId: 1 }], ['update', 20, { active: true }]]);
});
test('with the space list unreadable a tab of a named space picked from the bar is only activated', async () => {
  assert.deepEqual((await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { known: null, via: 'pickTab-direct' })).log, [['update', 20, { active: true }]]);
});
// Task 9a fix round 2: unreadable evidence is not absence. Listed when the bar listed it, then unreadable as the switch
// runs: nothing is moved, the tab is only activated.
test('a named switch whose list becomes unreadable as it runs moves nothing', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { known: [1, 2], knownLater: null });
  assert.deepEqual(log, [['update', 20, { active: true }]]);
});
test('a dead tab picked while the list is unreadable is only activated', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 9) }, { known: null, via: 'pickTab-direct' });
  assert.deepEqual(log, [['update', 20, { active: true }]]);
});
// Fix round 3: listed in space 2 (X); before Enter runs the pick, the tab moves into space 3 (Y) and X is deleted. The
// pick is made on what is true then: the window shows Y with the tab, never a switch into the old X.
test('a tab that moved into another space while X disappeared is shown in its new space, never switched to the old one', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { known: [1, 2], knownLater: [1, 3], moveTo: 3 });
  assert.deepEqual(log, [['switch', 1, 3], ['update', 20, { active: true }]]);
});
// the coordinator's race: the tab moves into space 3 and space 2 is deleted WHILE the pick's own reads run (the 3rd list
// read is where the old code revalidated). Whatever was read, no switch into space 2 may follow that change.
test('no switch into a space that left the list while the pick was reading', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { known: [1, 2], knownLater: [1, 2], raceAt: 2 });
  const changed = log.findIndex((c) => c[0] === 'list-changed');
  assert.ok(!log.some((c, i) => changed >= 0 && i > changed && c[0] === 'switch' && c[2] === 2), `log ${JSON.stringify(log)}`);
});
// Fix round 4: a listed tab that closed before Enter runs the pick: nothing happens (no switch into its old space, no focus).
test('a listed tab that closed before the pick runs switches nothing and focuses nothing', async () => {
  const { log } = await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { closeBefore: true, minimised: [] });
  assert.deepEqual(log, []);
});
test('with nothing typed, a tab of a deleted space is never offered, even as the only tab', async () => {
  const { log, inputs } = await pickTab({ 10: page(10, 9), 20: page(20, 9) }, { typed: '' });
  assert.deepEqual(log, [], 'Enter on the empty list picks nothing');
  assert.ok(inputs.length >= 1);
});
// The list with nothing typed (Byron, 2026-11-15): this window's tabs of the space on screen here, most recently used
// first, without favorites' and pins' tabs, Vivaldi-pinned tabs or the active tab. Window 1 shows space 1 (its active
// tab, 10, is there) unless `record` says otherwise. bound: the tabs the sidebar has bound to a favorite or pin; pins: the
// ids of the favorites and pins the sidebar shows now.
async function emptyBar(tabs, { known = [1, 2], record = null, bound = [], pins = ['55'], opener = 'vm-open-command-bar' } = {}) {
  const space = await spaces(tabs);
  vm.runInContext(source('08-pins.js'), space.context);
  space.context.window.__vm.native = { spaceIds: async () => known, hasSwitch: () => false, record: () => record };
  space.context.window.__vm.boundTabIds = () => new Set(bound);
  space.context.window.__vm.pinIds = () => new Set(pins);
  await space.context.events[opener]();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  return { ...space, rows: () => tabRows(space.made) };
}
const listed = (rows) => rows.map((r) => (/^https:\/\/(\d+)\.test\/$/.test(r.label) ? Number(/(\d+)/.exec(r.label)[1]) : r.label));
const used = (tab, at, extra = {}) => ({ ...tab, lastAccessed: at, ...extra });
const ext = (space, more) => JSON.stringify({ workspaceId: space, ...more });
test("with nothing typed the bar lists only this window's tabs of the space on screen, most recently used first", async () => {
  const { rows } = await emptyBar({
    10: used(page(10, 1), 900), 11: used(page(11, 1), 100), 12: used(page(12, 1), 300), 13: used(page(13, 1), 200), 14: page(14, 1),
    15: blank(15, 1), 20: used(page(20, 2), 999), 21: used(page(21, 0), 998), 30: used(page(30, 3, 2), 997), 31: used(page(31, 1, 2), 996),
  });
  assert.deepEqual(listed(rows()), [12, 13, 11, 14], 'not 20 or 21 (other spaces), not 30 or 31 (window 2), not the blank 15, not the active 10');
  assert.ok(rows().every((r) => r.says === 'Switch to Tab'), 'tab rows only: no other section');
});
test("with nothing typed, favorites' and pins' tabs and Vivaldi-pinned tabs are left out", async () => {
  const { rows } = await emptyBar({
    10: page(10, 1), 11: { ...used(page(11, 1), 500), vivExtData: ext(1, { vivarcPin: '55' }) }, 12: used(page(12, 1), 600, { pinned: true }),
    13: used(page(13, 1), 700), 14: used(page(14, 1), 100),
  }, { bound: [13] });
  assert.deepEqual(listed(rows()), [14], '11 carries a favorite, 12 is pinned, 13 is bound by the sidebar');
});
// Codex review: unpinning the last favorite or pin leaves its tab open with its vivarcPin mark (08-pins.js clears nothing
// when no pins remain), and the sidebar lists it as an ordinary tab: so does the bar.
test("with nothing typed a tab whose favorite or pin is gone (its mark left behind) is listed as an ordinary tab", async () => {
  const tabs = { 10: page(10, 1), 11: { ...used(page(11, 1), 500), vivExtData: ext(1, { vivarcPin: '55' }) }, 14: used(page(14, 1), 100) };
  assert.deepEqual(listed((await emptyBar(tabs, { pins: [] })).rows()), [11, 14], 'the last pin, 55, was unpinned');
  assert.deepEqual(listed((await emptyBar(tabs, { pins: ['56'] })).rows()), [11, 14], 'another pin remains, not 55');
  assert.deepEqual(listed((await emptyBar(tabs, { pins: ['55'] })).rows()), [14], 'while 55 is a pin its tab stays out');
});
// The rule for a favorite's or pin's tab lives in one place, workspaces.heldTabs (07-workspaces.js), shared by the empty
// bar and the Ctrl+Tab switcher (Byron, 2026-11-16): bound by the sidebar, a vivarcPin mark naming a favorite or pin the
// sidebar shows now, or Vivaldi-pinned. It reads the sidebar when asked, and nothing readable means nothing is held.
test("a favorite's or pin's tab is told in one place (workspaces.heldTabs), read when asked", () => {
  const context = vm.createContext({ console: { log() {}, warn() {} }, URL, window: { __vm: {} } });
  vm.runInContext(source('07-workspaces.js'), context);
  vm.runInContext(source('08-pins.js'), context);
  const { heldTabs } = context.window.__vm.workspaces;
  const tabs = [page(11, 1), { ...page(12, 1), vivExtData: ext(1, { vivarcPin: '55' }) }, { ...page(13, 1), vivExtData: ext(1, { vivarcPin: '56' }) },
    { ...page(14, 1), pinned: true }, page(15, 1)];
  const held = () => { const h = heldTabs(); return tabs.filter((t) => h(t)).map((t) => t.id); };
  assert.deepEqual(held(), [14], 'no sidebar to read: only the Vivaldi-pinned tab');
  context.window.__vm.boundTabIds = () => new Set([11]);
  context.window.__vm.pinIds = () => new Set(['55']);
  assert.deepEqual(held(), [11, 12, 14], '11 bound, 12 marked for pin 55 (shown), not 13 (its pin 56 is gone)');
  context.window.__vm.boundTabIds = () => { throw new Error('not ready'); };
  assert.deepEqual(held(), [12, 14], 'an unreadable binding binds nothing');
});
test("the empty bar and the switcher have no copy of the favorites' and pins' rule", () => {
  for (const name of ['20-command-bar.js', '25-tab-switcher.js']) {
    assert.match(source(name), /workspaces\??\.heldTabs/, name);
    assert.doesNotMatch(source(name), /boundTabIds|pinIds|pinOf/, name);
  }
});
test('with nothing typed the active tab is left out, and the only tab makes an empty list', async () => {
  assert.deepEqual(listed((await emptyBar({ 10: used(page(10, 1), 900), 11: used(page(11, 1), 100) })).rows()), [11], "Ctrl+T's bar over tab 10");
  assert.deepEqual(listed((await emptyBar({ 10: page(10, 1) })).rows()), [], 'the space has only the active tab');
  const edit = await emptyBar({ 10: used(page(10, 1), 900), 11: used(page(11, 1), 100) }, { opener: 'vm-edit-url' });
  edit.inputs.at(-1).value = '';
  await edit.inputs.at(-1).events.input();
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(listed(edit.rows()), [11], "Ctrl+L's bar, its address cleared");
});
test('with nothing typed every eligible tab is listed (more than ten: the list scrolls), most recent first', async () => {
  const tabs = { 10: used(page(10, 1), 9999) };
  for (let id = 11; id <= 40; id++) tabs[id] = used(page(id, 1), id);
  const { rows } = await emptyBar(tabs);
  assert.deepEqual(listed(rows()), Array.from({ length: 30 }, (_, i) => 40 - i));
});
test('with nothing typed a space not known to exist lists nothing; the default space always can', async () => {
  assert.deepEqual(listed((await emptyBar({ 10: page(10, 9), 11: used(page(11, 9), 5), 12: used(page(12, 9), 6) })).rows()), [], 'space 9 is not in the list');
  assert.deepEqual(listed((await emptyBar({ 10: page(10, 1), 11: used(page(11, 1), 5) }, { known: null })).rows()), [], 'the list cannot be read');
  assert.deepEqual(listed((await emptyBar({ 10: page(10, 0), 11: used(page(11, 0), 5), 12: used(page(12, 1), 6) }, { known: null })).rows()), [11]);
});
test("with nothing typed Vivaldi's record says which space is on screen", async () => {
  const record = { activeIn: (w) => (w === 1 ? 2 : null), all: () => new Map([[2, 1]]) };
  const { rows } = await emptyBar({ 10: page(10, 1), 11: used(page(11, 1), 9), 20: used(page(20, 2), 1), 21: used(page(21, 2), 2) }, { record });
  assert.deepEqual(listed(rows()), [21, 20]);
});
test('typing still finds the tabs the empty list leaves out', async () => {
  const bar = await emptyBar({ 10: page(10, 1), 11: { ...page(11, 1), vivExtData: ext(1, { vivarcPin: '55' }) }, 20: page(20, 2) });
  for (const [text, id] of [['11.test', 11], ['20.test', 20]]) {
    bar.inputs.at(-1).value = text;
    await bar.inputs.at(-1).events.input();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(listed(bar.rows().filter((r) => r.says === 'Switch to Tab')).includes(id), `${text}: ${JSON.stringify(listed(bar.rows()))}`);
  }
});
test("without Vivaldi's record or switch a tab picked from the bar is activated as before", async () => {
  assert.deepEqual((await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { record: false })).log, [['update', 20, { active: true }]]);
  assert.deepEqual((await pickTab({ 10: page(10, 1), 20: page(20, 2) }, { hasSwitch: false })).log, [['update', 20, { active: true }]]);
});

// Ctrl+T (or `opener`) with open tabs listed, while bookmark and history lookups wait until answered for their text.
async function lookingUp(opener = 'vm-open-command-bar') {
  const space = await spaces({ 10: page(10, 1), 11: page(11, 1) });
  const { context, made } = space;
  const waiting = [];
  const lookup = text => new Promise(resolve => waiting.push({ text, resolve }));
  context.chrome.bookmarks.search = text => lookup(text);
  context.chrome.history.search = ({ text }) => lookup(text);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  await context.events[opener]();
  await settle();
  const input = space.inputs.at(-1);
  return {
    ...space, input, settle,
    pending: text => waiting.filter(w => w.text === text).length,
    answer: async text => {
      for (let i = 0; i < 5; i++) {
        for (const w of waiting.splice(0)) { if (w.text === text) w.resolve([]); else waiting.push(w); }
        await settle();
      }
    },
    type: text => { input.value = text; return input.events.input(); },
    // The hint on the row Enter runs: what the bar says Enter does.
    says: () => {
      const row = made.filter(node => node.className === 'vm-cmd-list').at(-1).children.find(node => node.className.includes('sel'));
      return row?.children.find(node => node.className === 'vm-cmd-hint')?.children[0].textContent;
    },
  };
}
test('Enter goes to a typed address at once, not to the tab listed before typing', async () => {
  const { calls, input, type, says, settle } = await lookingUp();
  type('google.com.au');
  await settle();
  assert.equal(says(), 'Go to URL');
  await press(input, 'Enter');
  assert.deepEqual({ ...calls.navigation.at(-1) }, { url: 'https://google.com.au' });
});
test('test_vivarc_never_writes_a_space_onto_a_new_tab', async () => {
  // the active tab (10) is in space 1; Vivaldi files the new tab in the window's space itself, so Vivarc sends no vivExtData
  const { calls, input, type, settle } = await lookingUp();
  type('google.com.au');
  await settle();
  await press(input, 'Enter');
  assert.deepEqual({ ...calls.navigation.at(-1) }, { url: 'https://google.com.au' });
  assert.ok(!('vivExtData' in calls.navigation.at(-1)));
});
test('Enter searches typed words at once, not the tab listed before typing', async () => {
  const { calls, input, type, says, settle } = await lookingUp();
  type('hello there');
  await settle();
  assert.equal(says(), 'Search');
  await press(input, 'Enter');
  assert.equal(calls.request.at(-1).query, 'hello there');
});
test('a row picked with the arrow keys stays picked when the lookups answer', async () => {
  const { calls, input, type, answer, says, settle } = await lookingUp();
  type('example.test');
  await settle();
  await press(input, 'ArrowDown');
  assert.equal(says(), 'Search');
  await answer('example.test');
  assert.equal(says(), 'Search');
  await press(input, 'Enter');
  assert.equal(calls.request.at(-1).query, 'example.test');
});
test('the bar editing the current URL acts on Enter at once', async () => {
  const { calls, input } = await lookingUp('vm-edit-url');
  await press(input, 'Enter');
  assert.deepEqual(calls.navigation.at(-1), { id: 10, url: 'https://10.test/', active: true });
});
test('Enter before the lookups answer leaves no error behind', async () => {
  const { input, type, answer } = await lookingUp();
  await press(input, 'g'); // a typed letter: inline completion is on
  const done = type('google.com.au');
  await press(input, 'Enter');
  await answer('google.com.au');
  await done;
});
test('only the latest text is completed inline, not the text an older keystroke looked up', async () => {
  const { input, type, answer, pending, settle } = await lookingUp();
  await press(input, 'g');
  type('goo');
  await settle();
  type('goog');
  await settle();
  await answer('goo');
  assert.equal(pending('goog'), 1, "goog's own lookup only: no inline completion of goog started for goo");
});
test('a search in an engine says Search too', async () => {
  const { input, type, says, settle } = await lookingUp();
  type('yt');
  await settle();
  await press(input, 'Tab');
  assert.equal(says(), 'Search');
});

// A window starting with `tabs` (the first is active) once Vivarc's CSS has loaded.
// `tabs` null: the tab query fails. `held` records whether the address bar is held hidden (the vm-launching marker) at
// start, and again after Vivaldi re-renders #browser's classes (core.js re-runs its onMark listeners then).
async function launch(tabs, cssLoaded = true) {
  const { context, calls } = setup();
  let ready;
  context.window.__vm.ready = new Promise(resolve => ready = resolve);
  const classes = new Set();
  const browser = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
  const marks = [];
  context.window.__vm.onMark = fn => { marks.push(fn); fn(browser); };
  (await loadBar(context)).events.keydown({ key: 'Escape', preventDefault() {} });
  const held = [classes.has('vm-launching')];
  classes.clear();
  marks.forEach(fn => fn(browser));
  held.push(classes.has('vm-launching'));
  const inputs = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); if (tag === 'input') inputs.push(node); return node; };
  context.setTimeout = fn => fn();
  calls.removed = [];
  Object.assign(context.chrome.tabs, {
    remove: async id => calls.removed.push(id),
    query: async q => { if (!tabs) throw new Error('no tabs'); return q.active ? tabs.slice(0, 1) : tabs; },
  });
  ready(cssLoaded);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  marks.forEach(fn => fn(browser)); // a re-render after the launch must not bring the hold back
  return { calls, inputs, held, stillHeld: classes.has('vm-launching') };
}
test("a starting window holds Vivaldi's address bar hidden, through re-renders, until the launch is settled", async () => {
  for (const [tabs, cssLoaded, bars, why] of [
    [[blank(10, 1)], true, 1, 'the bar opened'], [[page(10, 1)], true, 0, 'a page, no bar'],
    [[blank(10, 1)], false, 0, 'no Vivarc CSS'], [null, true, 0, 'the tab query failed'],
    [[{ id: 10, windowId: 1, get pendingUrl() { throw new Error('odd tab'); } }], true, 0, 'an unexpected error'],
  ]) {
    const { inputs, held, stillHeld } = await launch(tabs, cssLoaded);
    assert.deepEqual(held, [true, true], `held from the start: ${why}`);
    assert.equal(inputs.length, bars, why);
    assert.equal(stillHeld, false, `released: ${why}`);
  }
});
test('a window starting on a new tab opens the bar on it, and Escape keeps that tab', async () => {
  const { calls, inputs } = await launch([blank(10, 1), page(11, 1)]);
  assert.equal(inputs.length, 1);
  inputs[0].value = 'example.test';
  await inputs[0].events.input();
  await press(inputs[0], 'Enter');
  assert.deepEqual(calls.navigation.at(-1), { id: 10, url: 'https://example.test', active: true }, 'it loads in the new tab');
  const again = await launch([blank(10, 1)]);
  await press(again.inputs[0], 'Escape');
  assert.deepEqual(again.calls.removed, []);
});
test('a window starting on a page, or without Vivarc CSS, opens no bar', async () => {
  assert.equal((await launch([page(10, 1), blank(11, 1)])).inputs.length, 0);
  assert.equal((await launch([blank(10, 1)], false)).inputs.length, 0);
});

// A tab opened on `url` in the active tab's space: how many times does the bar open on it?
async function barsOnNewTab(url, ext = '{"workspaceId":1}') {
  const { context, calls } = setup();
  (await loadBar(context)).events.keydown({ key: 'Escape', preventDefault() {} });
  const inputs = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); if (tag === 'input') inputs.push(node); return node; };
  calls.onActivated({ tabId: 10, windowId: 1 });
  context.chrome.tabs.get = async () => ({ id: 10, windowId: 1, vivExtData: '{"workspaceId":1}' });
  context.Date = { now: () => Date.now() + 6000 };
  await calls.onCreated({ id: 20, windowId: 1, active: true, url: '', pendingUrl: url, vivExtData: ext });
  return inputs.length;
}
// Vivaldi's own pages are its start page with a section (Vivaldi's bundle.js); F2 > Bookmarks opens one directly.
for (const section of ['bookmarks', 'history', 'notes', 'calendar', 'dashboard']) {
  test(`Vivaldi's ${section} page is not a new tab: the bar stays shut`, async () => {
    assert.equal(await barsOnNewTab(`chrome://vivaldi-webui/startpage?section=${section}`), 0);
  });
}
for (const url of ['vivaldi://newtab', 'chrome://newtab', 'chrome://vivaldi-webui/startpage', 'chrome://vivaldi-webui/startpage?section=Speed-dials']) {
  test(`a new tab on ${url} still opens the bar`, async () => {
    assert.equal(await barsOnNewTab(url), 1);
  });
}
test('the palette switches the layout: Layout: Dia while it is off, Layout: Arc while it is on', async () => {
  for (const [on, next] of [[false, true], [true, false]]) {
    const { context } = setup();
    const input = await loadBar(context);
    const set = [];
    Object.assign(context.window.__vm.settings, { get: key => (key === 'diaLayout' ? on : true), set: (key, value) => set.push([key, value]) });
    input.value = 'layout';
    await input.events.input();
    input.events.keydown({ key: 'ArrowDown', preventDefault() {} }); // past the search row, to the one layout action
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(set, [['diaLayout', next]], `from ${on ? 'Dia' : 'Arc'}`);
  }
});
test('what a blank tab is lives in one place (07-workspaces.js); the Dia breadcrumb keeps an equal copy, the sidebar and the command bar none', () => {
  const rules = name => source(name).match(/^ {2}const (BLANK|SECTION) = .*$/gm);
  assert.equal(rules('07-workspaces.js').length, 2);
  assert.equal(rules('10-sidebar.js'), null);
  assert.equal(rules('20-command-bar.js'), null);
  assert.deepEqual(rules('15-dia.js'), rules('07-workspaces.js'));
});

// Task 9b fix rounds 1-2: the command bar is the only place to type an address, so a search it cannot run itself goes to
// Vivaldi's own address field, never to another engine. A POST engine is named by its own keyword (the default's too) and
// submitted; when the engine cannot be named (Vivaldi's engines unreadable) the words are shown there, not submitted.
const recordHandOvers = (context) => { const handed = []; context.window.__vm.nativeEntry = async (text, options) => { handed.push({ text, ...options }); return true; }; return handed; };
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
for (const failure of ['missing default', 'native request error', 'POST search']) {
  test(`a search the bar cannot run itself goes to Vivaldi's own field (${failure}), never to DuckDuckGo`, async () => {
    const { context, calls } = setup({ missing: failure === 'missing default' });
    if (failure === 'native request error') context.vivaldi.searchEngines.getSearchRequest = async () => { throw new Error('unavailable'); };
    if (failure === 'POST search') context.vivaldi.searchEngines.getSearchRequest = async () => ({ url: 'https://chosen.test/', postParams: 'q=test' });
    const handed = recordHandOvers(context);
    const input = await loadBar(context);
    await settle(1);
    input.value = 'test & caf\u00e9';
    await input.events.input();
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await settle();
    assert.equal(calls.navigation.some((n) => /duckduckgo/.test(n.url || '')), false, 'no DuckDuckGo');
    const want = failure === 'POST search' ? [['c test & caf\u00e9', true]] : [['test & caf\u00e9', false]];
    assert.deepEqual(handed.map((h) => [h.text, h.submit]), want);
  });
}
// Review round 2, Critical: a Search suggestion that starts with javascript: stays a search; nothing ever submits a script.
for (const failure of ['POST default engine', 'engines unreadable']) {
  test(`a Search suggestion starting with javascript: never runs or auto-submits (${failure})`, async () => {
    const { context, calls } = setup();
    context.vivaldi.searchEngines.getSearchRequest = failure === 'POST default engine'
      ? async () => ({ url: 'https://chosen.test/', postParams: 'q=x' }) : async () => { throw new Error('engines unreadable'); };
    const handed = recordHandOvers(context);
    context.fetch = async () => ({ ok: true, json: async () => ['js', ['javascript:alert(1)']] });
    const input = await loadBar(context);
    await settle(5);
    input.value = 'js';
    await input.events.input();
    await settle();
    // the rows: the typed words' search, then the suggestion; Enter on the suggestion
    const want = 'javascript:alert(1)';
    const at = 1; // js: its own search row first, the suggestion next
    for (let i = 0; i < (at > 0 ? at : 1); i++) input.events.keydown({ key: 'ArrowDown', preventDefault() {} });
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await settle();
    assert.equal(calls.navigation.some((n) => /^javascript:/i.test(n.url || '')), false, 'the bar never loads it');
    assert.equal(handed.length, 1, `one hand-over: ${JSON.stringify(handed)}`);
    assert.ok(handed[0].text.includes(want), `the suggestion was what got picked (${JSON.stringify(handed)})`);
    assert.equal(handed[0].submit, false, `a script was submitted: ${JSON.stringify(handed)}`);
  });
}
test("the hand-over boundary never submits a script, whoever asks", async () => {
  const { context } = setup();
  const handed = recordHandOvers(context);
  context.vivaldi.searchEngines.getSearchRequest = async () => ({ url: 'https://chosen.test/', postParams: 'q=x' });
  const input = await loadBar(context);
  await settle(5);
  // a keyword engine with no keyword of its own -> unnamed: shown, not submitted
  context.vivaldi.searchEngines.getTemplateUrls = async () => ({ defaultSearch: 'nokw', defaultPrivate: 'nokw', templateUrls: [{ guid: 'nokw', name: 'No keyword', url: 'https://n.test/?q={searchTerms}' }] });
  input.value = 'plain words';
  await input.events.input();
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.deepEqual(handed.map((h) => [h.text, h.submit]), [['plain words', false]], 'an engine without a keyword cannot be named: shown, not submitted');
});
test("a keyword engine that searches by POST goes to Vivaldi's field with its keyword before the words", async () => {
  const { context } = setup();
  context.vivaldi.searchEngines.getSearchRequest = async () => ({ url: 'https://chosen.test/', postParams: 'q=x' });
  const handed = recordHandOvers(context);
  const input = await loadBar(context);
  await settle(5);
  input.value = 'c';
  input.events.keydown({ key: 'Tab', preventDefault() {} }); // the engine chip
  await settle(2);
  input.value = 'words';
  await input.events.input();
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.deepEqual(handed.map((h) => h.text), ['c words']);
});

// What typed text means (08-search.js, search.resolve), as Vivaldi's own field reads it.
test('the resolver reads local, intranet and IP addresses as addresses', () => {
  const { search } = setup();
  const url = (t) => { const r = search.resolve(t); return r && r.kind === 'url' ? r.url : r && r.kind; };
  assert.equal(url('localhost'), 'http://localhost');
  assert.equal(url('localhost:3000'), 'http://localhost:3000');
  assert.equal(url('localhost:3000/api?x=1'), 'http://localhost:3000/api?x=1');
  assert.equal(url('127.0.0.1'), 'http://127.0.0.1');
  assert.equal(url('192.168.1.20:8080/admin'), 'http://192.168.1.20:8080/admin');
  assert.equal(url('::1'), 'http://[::1]/');
  assert.equal(url('fe80::1'), 'http://[fe80::1]/');
  assert.equal(url('[::1]:8080'), 'http://[::1]:8080');
  assert.equal(url('[2001:db8::1]/x'), 'http://[2001:db8::1]/x');
  assert.equal(url('intranet/wiki'), 'http://intranet/wiki');
  assert.equal(url('intranet:8080'), 'http://intranet:8080');
  assert.equal(url('nas.local:5000/'), 'http://nas.local:5000/');
});
test('the resolver keeps domains and explicit schemes, and rewrites chrome: and vivaldi: shorthands', () => {
  const { search } = setup();
  const url = (t) => { const r = search.resolve(t); return r && r.kind === 'url' ? r.url : r && r.kind; };
  assert.equal(url('example.com'), 'https://example.com');
  assert.equal(url('sub.example.co.uk/path?q=1'), 'https://sub.example.co.uk/path?q=1');
  assert.equal(url('m\u00fcnchen.de'), 'https://m\u00fcnchen.de');
  assert.equal(url('xn--mnchen-3ya.de'), 'https://xn--mnchen-3ya.de');
  for (const t of ['http://a.test/', 'file:///C:/Users/', 'about:blank', 'view-source:https://x.test/', 'chrome://version',
    'vivaldi://settings', 'data:text/html,<b>hi there</b>', 'mailto:a@b.test', 'magnet:?xt=urn:x', 'web+foo:bar', 'myapp://open',
    'chrome-extension://abc/page.html']) assert.equal(url(t), t, t);
  assert.equal(url('chrome:version'), 'chrome://version');
  assert.equal(url('vivaldi:settings'), 'vivaldi://settings');
});
test("the resolver leaves javascript: to Vivaldi's own field, and searches for everything else", () => {
  const { search } = setup();
  assert.equal(search.resolve('javascript:alert(1)').kind, 'native');
  assert.equal(search.resolve('JavaScript:void(0)').kind, 'native');
  for (const t of ['hello world', 'what is 2+2', 'note: buy milk', 're:something', '1234', 'x.y', 'localhost is down', 'mailto:', '1/2', '2026/11/15', '10:30', '12:00:00'])
    assert.equal(search.resolve(t).kind, 'search', t);
  assert.equal(search.resolve('vbscript:x').kind, 'native');
  assert.equal(search.resolve(''), null);
  assert.equal(search.resolve('   '), null);
});
test('the resolver does not take times, known schemes or impossible ports for host:port, and reads drive paths as files', () => {
  const { search } = setup();
  const url = (t) => { const r = search.resolve(t); return r && r.kind === 'url' ? r.url : r && r.kind; };
  assert.equal(url('tel:123'), 'tel:123');
  assert.equal(url('mailto:x@y.test'), 'mailto:x@y.test');
  assert.equal(url('10:30'), 'search');
  assert.equal(url('12:00:00'), 'search');
  assert.equal(url('localhost:99999'), 'native');
  assert.equal(url('127.0.0.1:65536'), 'native');
  assert.equal(url('127.0.0.1:65535'), 'http://127.0.0.1:65535');
  assert.equal(url('2001:db8:0:0:0:0:0:1'), 'http://[2001:db8:0:0:0:0:0:1]/');
  assert.equal(url('C:\\Users\\x\\a.html'), 'file:///C:/Users/x/a.html');
  assert.equal(url('C:/Program Files/x.txt'), 'file:///C:/Program Files/x.txt');
});
// Review round 2, I1: hosts are parsed and validated; address-shaped text is never a search.
test('the resolver reads trailing dots, IPv4-embedded and zoned IPv6, Unicode dots and paths with spaces as addresses', () => {
  const { search } = setup();
  const url = (t) => { const r = search.resolve(t); return r && r.kind === 'url' ? r.url : r && r.kind; };
  assert.equal(url('http://nas/team plan'), 'http://nas/team%20plan');
  assert.equal(url('example.com/a b'), 'https://example.com/a%20b');
  assert.equal(url('https://x.y/?q= a'), 'https://x.y/?q=%20a');
  assert.equal(url('localhost./admin'), 'http://localhost./admin');
  assert.equal(url('nas.local.:8080/private'), 'http://nas.local.:8080/private');
  assert.equal(url('a.b/private'), 'http://a.b/private');
  assert.equal(url('::ffff:192.168.1.10'), 'http://[::ffff:192.168.1.10]/');
  assert.equal(url('fe80::1%eth0'), 'http://[fe80::1%eth0]/');
  assert.equal(url('[fe80::1%25eth0]:80/x'), 'http://[fe80::1%25eth0]:80/x');
  assert.equal(url('\u4f8b\u5b50\u3002\u6d4b\u8bd5'), 'https://\u4f8b\u5b50.\u6d4b\u8bd5');
  assert.equal(url('b\u00fccher.de'), 'https://b\u00fccher.de');
  assert.equal(url('xn--bcher-kva.de'), 'https://xn--bcher-kva.de');
});
test('malformed address-shaped text goes to Vivaldi\'s field unsubmitted, never to a search', () => {
  const { search } = setup();
  for (const t of ['[1]', '[dead.beef]', '[::1', 'a::b::c', '999.1.1.1', '999.1.1.1/x', 'http://a b', 'http:// spaced', 'localhost:99999', '[::1]:70000'])
    assert.equal(search.resolve(t).kind, 'native', t);
  assert.equal(search.isIPv6('1:2:3:4:5:6:7:8'), true);
  assert.equal(search.isIPv6('1:2:3:4:5:6:7'), false);
  assert.equal(search.isIPv6('1::2::3'), false);
  assert.equal(search.isIPv6('::ffff:300.1.1.1'), false);
});
test('address-shaped text is never sent to the suggestion service while it is typed', async () => {
  for (const typed of ['intranet/wiki', 'nas.local:8080', '192.168.1.1', 'a.b/private', '[::1]', 'secret.corp']) {
    const { context, calls } = setup();
    const input = await loadBar(context);
    await settle(5);
    input.value = typed;
    await input.events.input();
    await settle();
    assert.equal(calls.fetch.length, 0, `${typed} was sent for suggestions: ${JSON.stringify(calls.fetch)}`);
  }
  const { context, calls } = setup();
  const input = await loadBar(context);
  await settle(5);
  input.value = 'plain words';
  await input.events.input();
  await settle();
  assert.equal(calls.fetch.length, 1, 'plain words still get suggestions');
});
// Final fix round, Codex Important 1: a UNC path (\\server\share\..., spaces and all) is a network address, never a search:
// it goes to Vivaldi's field unsubmitted, and it is never sent to the suggestion service while it is typed.
const UNC = [String.raw`\\server\share\private plan.xlsx`, String.raw`\\server\share`, String.raw`\\server`,
  String.raw`\\nas.local\backups\2026 tax\return.pdf`, String.raw`\\192.168.1.5\c$\Users`, String.raw`\\?\C:\Very long\path`,
  String.raw`  \\server\share\x y  `, String.raw`\\server/share/mixed slashes`];
test('a UNC path, with spaces or not, is native and address-shaped, never a search', () => {
  const { search } = setup();
  for (const t of UNC) {
    assert.equal(search.resolve(t).kind, 'native', t);
    assert.equal(search.addressShaped(t), true, t);
  }
  assert.equal(search.resolve(String.raw`a\b words`).kind, 'search', 'a backslash inside words is still words');
});
test('a UNC path is never sent to the suggestion service while it is typed', async () => {
  for (const typed of UNC) {
    const { context, calls } = setup();
    const input = await loadBar(context);
    await settle(5);
    input.value = typed;
    await input.events.input();
    await settle();
    assert.equal(calls.fetch.length, 0, `${typed} was sent for suggestions: ${JSON.stringify(calls.fetch)}`);
  }
});
test('a bare word is a search first, with its intranet address offered too', () => {
  const { search } = setup();
  assert.deepEqual({ ...search.resolve('intranet') }, { kind: 'search', alt: 'http://intranet/' });
  assert.equal(search.resolve('intranet').alt, 'http://intranet/');
});
test('the address being edited keeps its own scheme', () => {
  const { search } = setup();
  assert.equal(search.resolve('foo:bar baz', { editing: 'foo:bar' }).kind, 'search');
  assert.deepEqual({ ...search.resolve('foo:baz', { editing: 'foo:bar' }) }, { kind: 'url', url: 'foo:baz' });
  assert.equal(search.resolve('javascript:x', { editing: 'javascript:y' }).kind, 'native');
});
test("typed addresses go where Vivaldi's field would send them, and javascript: leads to Vivaldi's field", async () => {
  for (const [typed, want] of [['localhost:3000', 'http://localhost:3000'], ['10.0.0.1/x', 'http://10.0.0.1/x'], ['intranet/wiki', 'http://intranet/wiki']]) {
    const { context, calls } = setup();
    const input = await loadBar(context);
    await settle(5);
    input.value = typed;
    await input.events.input();
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await settle();
    assert.equal(calls.navigation.at(-1)?.url, want, typed);
  }
  const { context, calls } = setup();
  const handed = recordHandOvers(context);
  const input = await loadBar(context);
  await settle(5);
  input.value = 'javascript:alert(1)';
  await input.events.input();
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.equal(calls.navigation.length, 0, 'the bar never loads a javascript: address itself');
  assert.deepEqual(handed.map((h) => [h.text, h.submit]), [['javascript:alert(1)', false]], "shown in Vivaldi's field, not submitted");
});
test("the last row hands what is typed to Vivaldi's own field (the escape hatch)", async () => {
  const { context } = setup();
  const handed = recordHandOvers(context);
  const input = await loadBar(context);
  await settle(5);
  input.value = 'kw some words';
  await input.events.input();
  input.events.keydown({ key: 'ArrowUp', preventDefault() {} }); // from the first row up: the last row
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.deepEqual(handed.map((h) => [h.text, h.submit]), [['kw some words', false]]);
});

// Split View from the bar: a page that leaves its old split must lose its `tiling` key. chrome.tabs.update MERGES
// vivExtData and only a key written as null is dropped (measured on 8.2), so the fake below merges the same way.
test("Split View clears the displaced tab's old split with null, not undefined", async () => {
  const { context } = setup();
  const store = {
    1: { id: 1, windowId: 1, index: 0, url: 'https://one.test/', ext: { tiling: { id: 'old', layout: 'row', type: 'selection', index: 0 }, keep: 1 } },
    2: { id: 2, windowId: 1, index: 1, url: 'https://two.test/', ext: { tiling: { id: 'old', layout: 'row', type: 'selection', index: 1 }, keep: 2 } },
  };
  const view = t => ({ ...t, vivExtData: JSON.stringify(t.ext) });
  Object.assign(context.chrome.tabs, {
    get: async id => view(store[id]),
    query: async q => Object.values(store).filter(t => q.active ? t.id === 1 : true).map(view),
    create: async o => (store[3] = { id: 3, windowId: 1, index: o.index, url: 'vivaldi://newtab', ext: {} }, view(store[3])),
    update: async (id, o) => {
      if (!o.vivExtData) return;
      for (const [k, v] of Object.entries(JSON.parse(o.vivExtData))) { if (v === null) delete store[id].ext[k]; else store[id].ext[k] = v; }
    },
  });
  // the shared helpers come from the real 00-core.js, run in a context that sees the same chrome
  const core = vm.createContext({ window: {}, chrome: context.chrome, console: context.console, indexedDB: { open: () => ({}) },
    document: { querySelector: () => null, documentElement: {} }, MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }), setTimeout() {}, vivaldi: {} });
  vm.runInContext(source('00-core.js'), core);
  const { setExtData, tilingOf, unsplit } = core.window.__vm;
  const input = await loadBar(context);
  Object.assign(context.window.__vm, { setExtData, tilingOf, unsplit });
  context.crypto = { randomUUID: () => 'fresh' };
  const made = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); made.push(node); return node; };
  input.value = 'side by side';
  await input.events.input();
  await new Promise(resolve => setImmediate(resolve));
  const row = made.find(n => n.className === 'vm-cmd-row' && n.children.some(c => c.textContent === 'Split View: Side by Side'));
  assert.ok(row, 'the Split View row is offered');
  row.events.click();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(store[2].ext.tiling, undefined, 'the displaced peer has no tiling key left');
  assert.equal(store[2].ext.keep, 2, 'its other keys stay');
  assert.equal(store[1].ext.tiling.id, 'fresh');
  assert.equal(store[3].ext.tiling.id, 'fresh');
});

// Task 8q: a way back to Vivaldi's Start Page. A start page the user asked for carries vivExtData.vmStart and is a page like
// any other; a start page that opened by itself is still a new tab.
const START = 'chrome://vivaldi-webui/startpage';
test('a new tab on the start page opens the bar unless its tab carries the start-page mark', async () => {
  assert.equal(await barsOnNewTab(START), 1);
  assert.equal(await barsOnNewTab(START, '{"workspaceId":1,"vmStart":true}'), 0);
  assert.equal(await barsOnNewTab(`${START}?section=Speed-dials`, '{"workspaceId":1,"vmStart":true}'), 0);
  assert.equal(await barsOnNewTab('vivaldi://newtab', '{"workspaceId":1,"vmStart":true}'), 0);
});
// A bar on blank tab 20 (space 2), with setExtData recording what it is asked to write into which tab, in order with the navigations.
async function startBar() {
  const space = await spaces({ 10: page(10, 1), 20: blank(20, 2) });
  const log = [];
  space.context.window.__vm.setExtData = async (tab, patch) => { log.push(['mark', tab.id, { ...patch }]); };
  const update = space.context.chrome.tabs.update;
  space.context.chrome.tabs.update = async (id, opts) => { log.push(['update', id, { ...opts }]); return update(id, opts); };
  await space.activate(20);
  return { ...space, log, input: space.inputs.at(-1) };
}
for (const typed of [START, `${START}?section=Speed-dials`, 'vivaldi://newtab', 'chrome://newtab/', 'vivaldi://startpage']) {
  test(`typing "${typed}" in the bar opens the start page in that tab and marks it first`, async () => {
    const { log, input } = await startBar();
    assert.ok(input, 'the bar is open on the blank tab');
    input.value = typed;
    await input.events.input();
    await press(input, 'Enter');
    assert.deepEqual(log, [['mark', 20, { vmStart: true }], ['update', 20, { url: START, active: true }]]);
  });
}
test("typing one of Vivaldi's start page sections goes there as typed, unmarked", async () => {
  const { log, input } = await startBar();
  input.value = `${START}?section=Bookmarks`;
  await input.events.input();
  await press(input, 'Enter');
  assert.deepEqual(log, [['update', 20, { url: `${START}?section=Bookmarks`, active: true }]]);
});
test('the start page row opens it in a new active tab and marks it; the bar stays shut for that tab', async () => {
  const s = await startBar();
  s.input.events.keydown({ key: 'Escape', preventDefault() {} });
  const { context, calls, inputs, log } = s;
  const bars = inputs.length;
  context.chrome.tabs.create = async opts => { // Vivaldi's event for the tab arrives before create answers
    log.push(['create', { ...opts }]);
    await calls.onCreated({ id: 77, windowId: 1, active: true, url: '', pendingUrl: opts.url, vivExtData: '{"workspaceId":1}' });
    return { id: 77, windowId: 1, index: 3, url: '', pendingUrl: opts.url };
  };
  await context.window.__vm.openStartPage();
  assert.deepEqual(log.slice(0, 2), [['create', { url: START, active: true }], ['mark', 77, { vmStart: true }]]);
  assert.equal(inputs.length, bars, 'no bar opened over it');
});
test('the start page mark is cleared when its tab leaves the start page, and a tab that moves from a page to it is marked', async () => {
  const { context } = setup();
  let changed;
  context.chrome.tabs.onUpdated = { addListener: fn => { changed = fn; } };
  const marks = [];
  await loadBar(context);
  context.window.__vm.setExtData = async (tab, patch) => { marks.push([tab.id, { ...patch }]); };
  await new Promise(resolve => setImmediate(resolve));
  const marked = { id: 5, windowId: 1, vivExtData: '{"vmStart":true}' };
  changed(5, { url: `${START}?section=Speed-dials` }, { ...marked, url: `${START}?section=Speed-dials` });
  changed(5, { url: `${START}?section=Bookmarks` }, { ...marked, url: `${START}?section=Bookmarks` });
  assert.deepEqual(marks, [], 'moving about inside the start page keeps the mark');
  changed(5, { url: 'https://example.test/' }, { ...marked, url: 'https://example.test/' });
  assert.deepEqual(marks, [[5, { vmStart: null }]]);
  marks.length = 0;
  const bare = { id: 6, windowId: 1, vivExtData: '{}' };
  changed(6, { url: START }, { ...bare, url: START });
  assert.deepEqual(marks, [], 'a tab with no page before it is a new tab, not a start page asked for');
  changed(6, { url: 'https://example.test/' }, { ...bare, url: 'https://example.test/' });
  changed(6, { url: START }, { ...bare, url: START });
  assert.deepEqual(marks, [[6, { vmStart: true }]], 'a page navigated to the start page was asked for');
  changed(7, { url: START }, { id: 7, windowId: 2, vivExtData: '{}', url: START });
  assert.equal(marks.length, 1, "another window's tabs are not this window's business");
});

// ---- Task 9b fix round 3 (review-9b-codex-r3.md) ----
// Important 1: the shared hand-over boundary. Whoever calls it (handOver included) and however the scheme is written, an
// address that could run a script (javascript:, vbscript:, data:) is never submitted.
const PROHIBITED = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)',
  '\u0001javascript:alert(1)', 'vbscript:msgbox(1)', 'VBScript:x', 'data:text/html,<script>alert(1)</script>', 'DATA:text/html,x',
  ' data:text/html,x', 'da\tta:text/html,<script>alert(1)</script>', '\u3000javascript:alert(1)', '\u00a0javascript:alert(1)',
  '\ufeffjavascript:alert(1)', '\u2028javascript:alert(1)', '\u3000data:text/html,<script>alert(1)</script>'];
test('search.neverSubmit reads the scheme as the URL parser does', () => {
  const { search } = setup();
  for (const t of PROHIBITED) assert.equal(search.neverSubmit(t), true, JSON.stringify(t));
  for (const t of ['https://example.test/', 'c javascript:alert(1)', 'about:blank', 'view-source:https://x.test/', 'words data: x'])
    assert.equal(search.neverSubmit(t), false, JSON.stringify(t));
});
test('a direct handOver of every prohibited scheme with submit asked is shown, never submitted', async () => {
  const { context } = setup();
  const handed = recordHandOvers(context);
  await loadBar(context);
  for (const t of PROHIBITED) await context.window.__vm.commandBar.handOver(t, { tabId: 5, submit: true });
  await context.window.__vm.commandBar.handOver('https://example.test/', { tabId: 5, submit: true });
  assert.deepEqual(handed.map((h) => [h.text, h.submit]), [...PROHIBITED.map((t) => [t, false]), ['https://example.test/', true]]);
});
// The same at Vivaldi's real field code (nativeFieldEntry, no recording hook): no Enter is ever synthesised for them, and
// one is for an ordinary address (so the probe can see an Enter at all).
for (const via of ['handOver', 'fieldEntry']) test(`at the field itself (${via}), no Enter is synthesised for a prohibited scheme`, async () => {
  const { context } = setup();
  await loadBar(context);
  await settle(3);
  const keys = [];
  const field = { id: 'urlFieldInput', _v: '', events: {}, addEventListener() {}, removeEventListener() {}, setSelectionRange() {},
    focus() { context.document.activeElement = field; }, closest: () => null,
    dispatchEvent(e) { if (/^key/.test(e.type)) keys.push([field._v, e.type, e.key]); return true; } };
  const browserEl = { classList: { add() {}, remove() {}, contains: () => false }, style: { setProperty() {}, getPropertyValue: () => '' } };
  context.document.querySelector = (sel) => (/urlFieldInput/.test(sel) ? field : /#browser/.test(sel) ? browserEl : null);
  context.HTMLInputElement = class { get value() { return this._v; } set value(v) { this._v = v; } };
  context.Event = class { constructor(type, o) { this.type = type; Object.assign(this, o); } };
  context.KeyboardEvent = context.Event;
  context.setTimeout = (fn) => { setImmediate(fn); return 0; };
  context.setInterval = () => 0; context.clearInterval = () => {}; context.clearTimeout = () => {};
  Object.assign(context.chrome.tabs, { get: async (id) => ({ id, active: true, windowId: 1 }), query: async () => [{ id: 5, active: true, windowId: 1 }] });
  for (const t of [...PROHIBITED, 'https://example.test/']) {
    await context.window.__vm.commandBar[via](t, { tabId: 5, submit: true });
    await settle(3);
  }
  const entered = keys.filter(([, type, key]) => type === 'keydown' && key === 'Enter').map(([v]) => v);
  assert.deepEqual(entered, ['https://example.test/'], `Enter synthesised for: ${JSON.stringify(entered)}`);
});
// Important 2: a malformed authority is address-shaped whatever its path holds: never a search, never sent to suggestions.
const MALFORMED = ['nas.local:abc/private plan', 'nas.local:abc/private', 'nas.local:abc', 'localhost:abc', '192.168.1.1:x/y z', 'host:99999/x',
  'host:99999/x y', '[::1', '[::1 x', '[::1/x y', 'nas.local:80:90', 'http://host:99999/x', 'http://[::1/x', 'http://999.1.1.1/',
  'http://a:b:c/', 'https://nas.local:abc/x', 'ftp://[::1]:99999/', 'http://:80/', 'https://user@:80/x', 'nas.local:abc private plan', 'localhost:abc def',
  '192.168.1.1:8080 admin', '[::1]:80 x', 'nas.local:abc private', 'user@nas.local:abc', '[fe80::1 notes'];
test('a malformed authority is native whatever its path holds, and words with a colon stay words', () => {
  const { search } = setup();
  for (const t of MALFORMED) {
    assert.equal(search.resolve(t).kind, 'native', t);
    assert.equal(search.addressShaped(t), true, `${t}: one classification for suggestions and Enter`);
  }
  for (const t of ['note:abc', 're:x', 'note: buy milk', '10:30', '12:00:00', '[1] citation needed', 'localhost is down', 'e.g.:this',
    'e.g.: this', 'Ch.3:intro', 'fig.2:caption', 'v1.2:changelog', '[12:30 meeting]', '[dead:beef notes', '[a:b x', 'user@host.com', '10:30 meeting'])
    assert.equal(search.resolve(t).kind, 'search', t);
  const url = (t) => { const r = search.resolve(t); return r && r.kind === 'url' ? r.url : r && r.kind; };
  assert.equal(url('http://user:pw@host:8080/x'), 'http://user:pw@host:8080/x');
  assert.equal(url('http://[::1]:8080/'), 'http://[::1]:8080/');
  assert.equal(url('http://my_host/'), 'http://my_host/');
  assert.equal(url('http://host:/x'), 'http://host:/x');
  assert.equal(url('user@nas.local:8080/x'), 'http://user@nas.local:8080/x');
});
for (const typed of ['nas.local:abc/private plan', 'nas.local:abc/private', 'host:99999/x', '[::1 x', 'http://host:99999/x y',
  'nas.local:abc private plan', 'localhost:abc def', '192.168.1.1:8080 admin', 'user@nas.local:abc']) {
  test(`"${typed}" is never sent for suggestions while typed, and Enter shows it unsubmitted in Vivaldi's field`, async () => {
    const { context, calls } = setup();
    const handed = recordHandOvers(context);
    const input = await loadBar(context);
    await settle(5);
    for (let i = 1; i <= typed.length; i++) { // as it is typed, letter by letter from the first malformed prefix on
      input.value = typed.slice(0, i);
      await input.events.input();
    }
    await settle();
    const leaked = calls.fetch.filter((f) => decodeURIComponent(f.url).includes(typed.slice(0, Math.max(typed.indexOf(':') + 2, 4))));
    assert.deepEqual(leaked, [], `the malformed address was sent for suggestions: ${JSON.stringify(leaked)}`);
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await settle();
    assert.equal(calls.navigation.length, 0, `the bar loaded something: ${JSON.stringify(calls.navigation)}`);
    assert.equal(calls.request.length, 0, `it was searched: ${JSON.stringify(calls.request)}`);
    assert.deepEqual(handed.map((h) => [h.text, h.submit]), [[typed, false]]);
  });
}
// Important 3: the order of a request for the field and a tab switch is a counter, not the clock, and a tab-switching
// shortcut is never a request for the field.
test('focusIntent: an activation forgets earlier requests, even in the same millisecond; a later one counts', () => {
  const { context } = setup();
  vm.runInContext(source('07-workspaces.js'), context);
  const intent = context.window.__vm.workspaces.focusIntent();
  intent.asked(1000); intent.activated();
  assert.equal(intent.userAsked(1000, 1500), false, 'asked, then the switch, same ms: passive');
  intent.activated(); intent.asked(1000);
  assert.equal(intent.userAsked(1000, 1500), true, 'the switch, then asked, same ms: a request');
  assert.equal(intent.userAsked(2500, 1500), false, 'too long ago');
  assert.equal(context.window.__vm.workspaces.focusIntent().userAsked(0, 1500), false, 'nothing asked yet');
});
test("addressKeys: tab-switching shortcuts never ask for the field; Vivaldi's own focus keys and other shortcuts do", () => {
  const { context } = setup();
  vm.runInContext(source('07-workspaces.js'), context);
  const norm = (k) => k.toLowerCase().split('+').sort().join('+');
  const asks = context.window.__vm.workspaces.addressKeys(null, norm);
  for (const k of ['ctrl+tab', 'ctrl+shift+tab', 'ctrl+pagedown', 'ctrl+pageup', 'ctrl+1', 'ctrl+9', 'meta+1', 'ctrl+w', 'ctrl+shift+t', '2'])
    assert.equal(asks(norm(k)), false, k);
  for (const k of ['ctrl+l', 'meta+l', 'f8', 'ctrl+shift+b', 'alt+q']) assert.equal(asks(norm(k)), true, k);
  const table = { COMMAND_TAB_SWITCH_FORWARD_ORDER: { shortcuts: ['alt+j'] }, COMMAND_WORKSPACE_SWITCH_2: { shortcuts: ['alt+2'] },
    COMMAND_FOCUS_ADDRESSFIELD: { shortcuts: ['alt+k', 'ctrl+tab'] }, COMMAND_NOTE: { shortcuts: ['alt+n'] } };
  const custom = context.window.__vm.workspaces.addressKeys(table, norm);
  assert.equal(custom(norm('alt+j')), false, 'a custom tab-switch key');
  assert.equal(custom(norm('alt+2')), false, 'a space-switch key');
  assert.equal(custom(norm('alt+k')), true, "a custom key for Vivaldi's focus-the-field command");
  assert.equal(custom(norm('ctrl+tab')), true, "bound to the field's command, it asks");
  assert.equal(custom(norm('alt+n')), true);
});
test('in the bar: Ctrl+Tab and its activation in the same millisecond are passive; Ctrl+L right after a switch is a request', async () => {
  const { context, calls } = setup();
  context.chrome.tabs.get = async (id) => ({ id, active: true, windowId: 1 });
  await loadBar(context);
  await settle(3);
  context.Date = class extends Date { static now() { return 5000; } };
  const shortcut = (key) => { for (const fn of context.shortcutFns) fn(key, key, 1); };
  const activate = (tabId) => { for (const fn of calls.activatedAll) fn({ tabId, windowId: 1 }); };
  const asked = () => context.window.__vm.commandBar.askedNow();
  shortcut('ctrl+tab'); activate(2);
  assert.equal(asked(), false, 'Ctrl+Tab, then its switch: the focus that follows is passive');
  activate(3); shortcut('ctrl+tab');
  assert.equal(asked(), false, 'Ctrl+Tab heard after its switch: still not a request');
  activate(4); shortcut('ctrl+l');
  assert.equal(asked(), true, 'Ctrl+L right after a switch, same millisecond: a request');
  shortcut('ctrl+l'); activate(5);
  assert.equal(asked(), false, 'a switch after the request forgets it');
  activate(6); shortcut('alt+q');
  assert.equal(asked(), true, 'another shortcut (a custom binding) after the switch is a request');
});

// The control for the leak tests above: the same letter-by-letter typing of plain words does reach the suggestion service,
// and Enter searches them (so a zero above is the classification, not a probe that sees nothing).
test('plain words typed the same way do get suggestions and a search', async () => {
  const { context, calls } = setup();
  const handed = recordHandOvers(context);
  const input = await loadBar(context);
  await settle(5);
  const typed = 'plain words here';
  for (let i = 1; i <= typed.length; i++) { input.value = typed.slice(0, i); await input.events.input(); }
  await settle();
  assert.ok(calls.fetch.some((f) => decodeURIComponent(f.url).includes('plain words')), `no suggestions asked: ${JSON.stringify(calls.fetch)}`);
  input.events.keydown({ key: 'Enter', preventDefault() {} });
  await settle();
  assert.deepEqual(calls.request.map((r) => r.query), [typed]);
  assert.deepEqual(handed, []);
});

// ---- Task 9b fix round 4 (review-9b-codex-r4.md): an explicit entry in Vivaldi's keyboard table replaces that command's
// defaults, and a key explicitly bound to a tab-switching command is never an address request.
test('addressKeys: a rebound focus command drops its defaults, and a key rebound to a tab switch never asks', () => {
  const { context } = setup();
  vm.runInContext(source('07-workspaces.js'), context);
  const norm = (k) => k.toLowerCase().split('+').sort().join('+');
  const table = { COMMAND_FOCUS_ADDRESSFIELD: { shortcuts: ['alt+k'] }, COMMAND_TAB_SWITCH_FORWARD_ORDER: { shortcuts: ['f8'] } };
  const asks = context.window.__vm.workspaces.addressKeys(table, norm);
  assert.equal(asks(norm('f8')), false, 'f8 is now a tab switch, not the field');
  assert.equal(asks(norm('alt+k')), true, "alt+k is the field's command now");
  assert.equal(asks(norm('ctrl+pagedown')), true, "the rebound switch command's own default is gone: just another shortcut");
  assert.equal(asks(norm('ctrl+tab')), false, 'a command with no entry keeps its defaults');
  // a key explicitly bound to a tab switch, though it is the focus command's default and that command has no entry
  const other = context.window.__vm.workspaces.addressKeys({ COMMAND_TAB_SWITCH_1: { shortcuts: ['ctrl+l'] } }, norm);
  assert.equal(other(norm('ctrl+l')), false, 'explicitly a tab switch: never an address request');
  assert.equal(other(norm('f8')), true, "the focus command's other default still asks");
  assert.equal(other(norm('ctrl+1')), true, "COMMAND_TAB_SWITCH_1's default was replaced");
  // defaults with no table: a space switch and closing a window are tab moves too
  const none = context.window.__vm.workspaces.addressKeys(null, norm);
  for (const k of ['ctrl+shift+1', 'ctrl+shift+9', 'ctrl+shift+w', 'shift+meta+w', 'shift+meta+]', 'meta+9']) assert.equal(none(norm(k)), false, k);
});
test("addressKeys: Ctrl+Tab freed from Vivaldi's cycling for Vivarc's switcher is still a tab switch, not a field request", () => {
  const { context } = setup();
  vm.runInContext(source('07-workspaces.js'), context);
  const norm = (k) => k.toLowerCase().split('+').sort().join('+');
  // what 05-bootstrap.js leaves: the cycling commands' entries without the two keys
  const freed = { COMMAND_TAB_SWITCH_FORWARD_SETTING: { shortcuts: [] }, COMMAND_TAB_SWITCH_BACK_SETTING: { shortcuts: [] } };
  const asks = context.window.__vm.workspaces.addressKeys(freed, norm);
  assert.equal(asks(norm('ctrl+tab')), false, 'the switcher switches tabs');
  assert.equal(asks(norm('ctrl+shift+tab')), false, 'the switcher steps back');
  assert.equal(asks(norm('ctrl+l')), true, "the field's own key still asks");
  assert.equal(asks(norm('alt+n')), true, 'any other shortcut still asks');
  const toField = context.window.__vm.workspaces.addressKeys({ ...freed, COMMAND_FOCUS_ADDRESSFIELD: { shortcuts: ['ctrl+tab'] } }, norm);
  assert.equal(toField(norm('ctrl+tab')), true, "bound to the field's command, it asks");
});
test('in the bar: the live keyboard table decides (f8 rebound to a tab switch is passive after its switch)', async () => {
  const { context, calls } = setup();
  context.chrome.tabs.get = async (id) => ({ id, active: true, windowId: 1 });
  context.vivaldi.prefs = { get: async (path) => (path === 'vivaldi.actions' ? { value: [{
    COMMAND_FOCUS_ADDRESSFIELD: { shortcuts: ['alt+k'] }, COMMAND_TAB_SWITCH_FORWARD_ORDER: { shortcuts: ['f8'] } }] } : undefined), onChanged: { addListener() {} } };
  await loadBar(context);
  await settle(5);
  context.Date = class extends Date { static now() { return 5000; } };
  const shortcut = (key) => { for (const fn of context.shortcutFns) fn(key, key, 1); };
  const activate = (tabId) => { for (const fn of calls.activatedAll) fn({ tabId, windowId: 1 }); };
  activate(2); shortcut('f8');
  assert.equal(context.window.__vm.commandBar.askedNow(), false, 'f8 (a tab switch here) heard after its switch');
  activate(3); shortcut('alt+k');
  assert.equal(context.window.__vm.commandBar.askedNow(), true, "alt+k (the field's command here) after a switch");
});
// Final fix round, Codex minor: the wait for the bar after a field request removes its listener on the timeout too, so
// declined opens never pile up listeners.
test('the wait for the bar removes its listener whether the bar opens or the wait times out', async () => {
  const { context } = setup();
  await loadBar(context);
  await settle(3);
  const live = new Map();
  context.window.addEventListener = (name, fn) => { if (!live.has(name)) live.set(name, new Set()); live.get(name).add(fn); };
  context.window.removeEventListener = (name, fn) => live.get(name)?.delete(fn);
  const timers = [];
  context.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  context.clearTimeout = () => {};
  const bar = context.window.__vm.commandBar;
  for (let i = 0; i < 5; i++) { const p = bar.barOpened(1500); timers.shift()(); await p; }
  assert.equal(live.get('vm-command-bar')?.size ?? 0, 0, 'listeners left after timed-out waits');
  const p = bar.barOpened(1500);
  assert.equal(live.get('vm-command-bar').size, 1);
  for (const fn of [...live.get('vm-command-bar')]) fn();
  await p;
  assert.equal(live.get('vm-command-bar').size, 0, 'listener left after the bar opened');
  assert.match(source('20-command-bar.js'), /const done = barOpened\(1500\);/, 'the field route waits through barOpened');
});
// Review of the final fix round, minor 1: a path in quotes (Explorer's "Copy as path") and a UNC path written with
// forward slashes are addresses too; "// note" (a slash pair, then a space) stays words.
test('a quoted path and a //server path are addresses, never a search, and never sent for suggestions', async () => {
  const { search } = setup();
  for (const t of [String.raw`"\\server\share\a b.xlsx"`, '//server/share/a b', '//server', String.raw`"//nas/x y"`])
    assert.equal(search.resolve(t).kind, 'native', t);
  const r = search.resolve(String.raw`"C:\Users\x y.txt"`);
  assert.equal(r.kind === 'url' ? r.url : r.kind, 'file:///C:/Users/x y.txt');
  for (const t of ['// note to self', '"quoted words"']) assert.equal(search.resolve(t).kind, 'search', t);
  for (const typed of [String.raw`"\\server\share\a b.xlsx"`, '//server/share/a b']) {
    const { context, calls } = setup();
    const input = await loadBar(context);
    await settle(5);
    input.value = typed;
    await input.events.input();
    await settle();
    assert.equal(calls.fetch.length, 0, `${typed} was sent for suggestions`);
  }
});
