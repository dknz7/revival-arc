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
    remove() {} focus() {} select() { this.selected = true; } scrollIntoView() {} querySelector() { return null; }
  }
  const browser = new Element('body');
  context.document = { body: browser, querySelector: () => browser, createElement: tag => { const node = new Element(tag); nodes.push(node); return node; } };
  context.setTimeout = () => {};
  context.CustomEvent = class {};
  const events = context.events = {};
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
async function pickTab(tabs, { shown = 1, all = [[1, 1]], record = true, hasSwitch = true } = {}) {
  const space = await editUrl(tabs);
  const log = [];
  space.context.window.__vm.native = {
    record: () => (record ? { activeIn: (w) => (w === 1 ? shown : 0), all: () => new Map(all) } : null),
    hasSwitch: () => hasSwitch,
    switchTo: async (w, s) => { log.push(['switch', w, s]); },
    focus: async (w) => { log.push(['focus', w]); },
  };
  const update = space.context.chrome.tabs.update;
  space.context.chrome.tabs.update = async (id, opts) => { log.push(['update', id, { ...opts }]); return update(id, opts); };
  space.inputs[0].value = '';
  await space.inputs[0].events.input();
  await press(space.inputs[0], 'Enter');
  return { ...space, log };
}
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
test('the sidebar, the Dia breadcrumb and the command bar agree on what a blank tab is', () => {
  const rules = name => source(name).match(/^ {2}const (BLANK|SECTION) = .*$/gm);
  assert.equal(rules('20-command-bar.js').length, 2);
  assert.deepEqual(rules('10-sidebar.js'), rules('20-command-bar.js'));
  assert.deepEqual(rules('15-dia.js'), rules('20-command-bar.js'));
});

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
