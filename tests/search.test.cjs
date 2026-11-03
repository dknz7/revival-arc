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
      query: async () => [], onCreated: { addListener(fn) { calls.onCreated = fn; } }, onActivated: { addListener(fn) { calls.onActivated = fn; } },
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
    remove() {} focus() {} scrollIntoView() {} querySelector() { return null; }
  }
  const browser = new Element('body');
  context.document = { body: browser, querySelector: () => browser, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } };
  context.setTimeout = () => {};
  context.CustomEvent = class {};
  const events = {};
  Object.assign(context.window, { addEventListener: (name, fn) => events[name] = fn, dispatchEvent() {} });
  Object.assign(context.window.__vm, { config: {}, cssLoaded: true, settings: { get: () => true, isOpen: () => settingsOpen }, normalise: x => x, shortcut: x => x, onShortcut() {} });
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
  const inputs = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); if (tag === 'input') inputs.push(node); return node; };
  context.Date = { now: () => Date.now() + 6000 };
  context.setTimeout = fn => fn();
  calls.removed = [];
  const active = { 1: 10 }; // window id -> its active tab
  Object.assign(context.chrome.tabs, {
    get: async id => tabs[id], remove: async id => calls.removed.push(id),
    query: async q => Object.values(tabs).filter(t => (!q.windowId || t.windowId === q.windowId) && (!q.active || t.id === active[t.windowId])),
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const activate = async (tabId, windowId = 1) => { active[windowId] = tabId; calls.onActivated({ tabId, windowId }); await settle(); };
  await activate(10);
  return { calls, inputs, activate };
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
// A tab opened on `url` in the active tab's space: how many times does the bar open on it?
async function barsOnNewTab(url) {
  const { context, calls } = setup();
  (await loadBar(context)).events.keydown({ key: 'Escape', preventDefault() {} });
  const inputs = [];
  const make = context.document.createElement;
  context.document.createElement = tag => { const node = make(tag); if (tag === 'input') inputs.push(node); return node; };
  calls.onActivated({ tabId: 10, windowId: 1 });
  context.chrome.tabs.get = async () => ({ id: 10, windowId: 1, vivExtData: '{"workspaceId":1}' });
  context.Date = { now: () => Date.now() + 6000 };
  await calls.onCreated({ id: 20, windowId: 1, active: true, url: '', pendingUrl: url, vivExtData: '{"workspaceId":1}' });
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

for (const failure of ['missing default', 'native request error', 'POST search']) {
  test(`DuckDuckGo fallback when ${failure}`, async () => {
    const { context, calls } = setup({ missing: failure === 'missing default' });
    if (failure === 'native request error') context.vivaldi.searchEngines.getSearchRequest = async () => { throw new Error('unavailable'); };
    if (failure === 'POST search') context.vivaldi.searchEngines.getSearchRequest = async () => ({ url: 'https://chosen.test/', postParams: 'q=test' });
    const input = await loadBar(context);
    await new Promise(resolve => setImmediate(resolve));
    input.value = 'test & caf\u00e9';
    await input.events.input();
    input.events.keydown({ key: 'Enter', preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.navigation[0].url, 'https://duckduckgo.com/?q=test%20%26%20caf%C3%A9');
  });
}
