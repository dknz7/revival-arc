import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jsrun import run_js  # noqa: E402


def js(expr, **data):
    return run_js("15-dia.js", expr, **data)


ADDRESS, ROW, FRAME = "vivaldi.address_bar.visible", "vivaldi.toolbars.navigation", "vivaldi.windows.use_native_decoration"
USERS_ROW = ["PanelToggle", "Back", "Forward", "Reload", "AddressField", "Extensions"]
ARC = {ADDRESS: False, ROW: USERS_ROW, FRAME: True}  # Vivarc's Arc layout over a user's own toolbar and window frame


def plan(on, current, saved=None, windows=True):
    return js("window.__vm.dia.plan(on, current, saved, windows)", on=on, current=current, saved=saved, windows=windows)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class Switch(unittest.TestCase):
    """The Dia layout turns on Vivaldi's address row (with its own contents) and, on Windows, Vivaldi's own window frame,
    keeping the user's values to put back when it is turned off."""

    def dia(self, windows=True):
        return js("window.__vm.dia.target(windows)", windows=windows)

    def test_turning_it_on_keeps_the_users_values_then_sets_the_layouts(self):
        out = plan(True, ARC)
        self.assertEqual(out["saved"], {ROW: USERS_ROW, FRAME: True})  # the address row goes back to off, not kept
        self.assertEqual(out["set"], self.dia())
        self.assertTrue(out["set"][ADDRESS])
        self.assertFalse(out["set"][FRAME])

    def test_on_a_mac_the_window_frame_is_left_alone(self):
        out = plan(True, {ADDRESS: False, ROW: USERS_ROW}, windows=False)
        self.assertNotIn(FRAME, out["set"])
        self.assertNotIn(FRAME, out["saved"])

    def test_a_window_that_finds_it_already_on_changes_and_keeps_nothing_new(self):
        kept = {ROW: USERS_ROW, FRAME: True}
        out = plan(True, self.dia(), saved=kept)
        self.assertEqual(out["set"], {})
        self.assertEqual(out["saved"], kept)

    def test_a_value_another_window_already_changed_is_never_kept_as_the_users(self):
        halfway = {**ARC, FRAME: False}  # another window has set the frame, not yet the rest
        out = plan(True, halfway)
        self.assertNotIn(FRAME, out["saved"])
        self.assertEqual(out["saved"][ROW], USERS_ROW)

    def test_a_kept_value_is_never_overwritten(self):
        out = plan(True, {**self.dia(), ROW: ["Back"]}, saved={ROW: USERS_ROW})
        self.assertEqual(out["saved"][ROW], USERS_ROW)

    def test_turning_it_off_puts_the_users_values_back_and_forgets_them(self):
        out = plan(False, self.dia(), saved={ROW: USERS_ROW, FRAME: True})
        self.assertEqual(out["set"], ARC)
        self.assertIsNone(out["saved"])

    def test_the_window_frame_changes_first_and_the_address_row_last_both_ways(self):
        # Vivaldi places its window buttons when the address row's pref changes: by then the frame must be set.
        on = list(plan(True, ARC)["set"])
        off = list(plan(False, self.dia(), saved={ADDRESS: False, ROW: USERS_ROW, FRAME: True})["set"])
        for order in (on, off):
            self.assertEqual(order[0], FRAME, order)
            self.assertEqual(order[-1], ADDRESS, order)

    def test_coming_back_from_the_layout_hides_the_address_row_which_the_arc_layout_needs(self):
        self.assertEqual(plan(False, {**ARC, ADDRESS: True}, saved={})["set"], {ADDRESS: False})

    def test_off_with_nothing_kept_leaves_vivaldis_prefs_alone(self):
        # the layout was never on (every window start): a user's own address row stays as it is
        self.assertEqual(plan(False, {**ARC, ADDRESS: True}, saved=None), {"set": {}, "saved": None})

    def test_the_layouts_values_match_the_installers(self):
        # vivarc.py's DIA_VALUES: a value the layout set is never kept as a user's original on reinstall
        import vivarc
        target = self.dia()
        self.assertEqual(target[ROW], vivarc.DIA_VALUES[ROW])
        self.assertEqual(target[FRAME], vivarc.DIA_VALUES[FRAME])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class Column(unittest.TestCase):
    def edges(self, left, right, margin_left, margin_right, width=1496):
        return js("window.__vm.dia.columnEdges(box, ml, mr, w)", box={"left": left, "right": right},
                  ml=f"{margin_left}px", mr=f"{margin_right}px", w=width)

    def test_the_cards_own_margin_is_not_space_beside_the_page(self):
        # sidebar on the left, card inset 8px on the right: the row still reaches the window's right corner
        self.assertEqual(self.edges(323, 1488, 0, 8), {"left": 323, "right": 0})

    def test_a_sidebar_on_the_right_and_a_hidden_sidebar(self):
        self.assertEqual(self.edges(8, 1173, 8, 0), {"left": 0, "right": 323})
        self.assertEqual(self.edges(0, 1488, 0, 8), {"left": 0, "right": 0})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class Breadcrumb(unittest.TestCase):
    def crumb(self, url, title=""):
        return js("window.__vm.dia.crumbOf(tab)", tab={"url": url, "title": title})

    def test_a_page_shows_its_site_and_title(self):
        self.assertEqual(self.crumb("https://www.github.com/dknz7", "dknz7 · GitHub"), {"site": "github.com", "title": "dknz7 · GitHub"})

    def test_a_new_tab_says_new_tab(self):
        for url in ("chrome://vivaldi-webui/startpage", "chrome://vivaldi-webui/startpage?section=Speed-dials", "vivaldi://newtab"):
            self.assertEqual(self.crumb(url, "Start Page"), {"site": "", "title": "New Tab"}, url)

    def test_vivaldis_own_pages_and_other_schemes_show_their_title(self):
        self.assertEqual(self.crumb("chrome://vivaldi-webui/startpage?section=bookmarks", "Bookmarks"), {"site": "", "title": "Bookmarks"})
        self.assertEqual(self.crumb("file:///C:/notes.txt"), {"site": "", "title": "file:///C:/notes.txt"})

    def test_a_page_without_a_title_shows_its_address(self):
        self.assertEqual(self.crumb("https://example.test/a"), {"site": "example.test", "title": "https://example.test/a"})


# Vivaldi's translation state for a tab, as its store holds it (measured on Vivaldi 8.2): a language once Chromium has
# determined it, `translateStep`, and after a translation `isTranslated` with the languages it went between.
GERMAN = {"pageLanguage": "de", "translateStep": "before_translate", "error": "no_error", "autoTranslate": False}
TRANSLATED = {**GERMAN, "translateStep": "after_translate", "isTranslated": True, "originalLang": "de", "translatedLang": "en"}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class Translate(unittest.TestCase):
    """A Translate button left of Copy link, only on a page that is not in English, using Vivaldi's own translation."""

    def button(self, state, url="https://de.wikipedia.org/wiki/Berlin"):
        return js("window.__vm.dia.translateOf(url, state)", url=url, state=state)

    def test_a_page_in_another_language_is_translated_from_it_into_english(self):
        self.assertEqual(self.button(GERMAN), {"revert": False, "from": "de", "label": "Translate"})
        self.assertEqual(self.button({"pageLanguage": "zh-CN", "translateStep": "idle"})["from"], "zh-CN")

    def test_an_english_page_has_no_button(self):
        for lang in ("en", "en-US", "en-GB", "EN"):
            self.assertIsNone(self.button({"pageLanguage": lang, "translateStep": "idle"}), lang)

    def test_a_language_not_yet_or_never_determined_has_no_button(self):
        # Vivaldi's store says "" until Chromium has determined it (a tab not shown yet, a page just navigated) and maps
        # Chromium's "und" to ""; chrome.tabs.detectLanguage says "und"
        for state in (None, {"pageLanguage": "", "translateStep": "idle"}, {"pageLanguage": "und", "translateStep": "idle"}):
            self.assertIsNone(self.button(state), state)

    def test_vivaldis_own_pages_and_other_schemes_have_no_button(self):
        for url in ("chrome://vivaldi-webui/startpage", "vivaldi://settings", "chrome-extension://abc/page.html",
                    "file:///C:/notes.txt", "about:blank", "", None):
            self.assertIsNone(self.button(GERMAN, url=url), url)

    def test_a_translated_page_offers_its_original_back(self):
        self.assertEqual(self.button(TRANSLATED), {"revert": True, "label": "Show original"})
        # translated by Vivaldi's own popup from English into another language: still one click back
        self.assertEqual(self.button({**TRANSLATED, "pageLanguage": "en", "originalLang": "en", "translatedLang": "fr"})["revert"], True)

    def test_after_show_original_it_offers_translate_again(self):
        # measured: a revert leaves translateStep at "after_translate" and turns isTranslated off
        self.assertEqual(self.button({**TRANSLATED, "isTranslated": False}), {"revert": False, "from": "de", "label": "Translate"})

    def test_while_translating_it_says_so(self):
        self.assertEqual(self.button({**GERMAN, "translateStep": "translating"})["label"], "Translating\u2026")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class TranslationState(unittest.TestCase):
    """The state is read from Vivaldi's own store, found in its webpack modules."""

    FAKE = """
      const store = { getPageState: (tabId) => ({ tabId, pageLanguage: "ja", translateStep: "idle" }) };
      const modules = {
        1: function () { return "nothing to see"; },
        2: function () { return "case\\"VIVALDI_TABS_LANGUAGE_DETERMINED\\":"; },
        3: function () { return "a module that is not the store"; },
      };
      const exportsOf = { 2: Object.defineProperty({}, "Z", { enumerable: true, get: () => store }), 3: { Z: {} } };
      const loaded = [];
      const require = (id) => { loaded.push(id); if (!(id in exportsOf)) throw new Error("not loaded: " + id); return exportsOf[id]; };
      require.m = modules;
      const chunks = { push: ([ids, extra, run]) => run(require) };
    """

    def test_the_state_comes_from_vivaldis_translation_store(self):
        out = js("(() => {" + self.FAKE + "return [window.__vm.dia.findTranslation(chunks)(42), loaded]; })()")
        self.assertEqual(out[0], {"tabId": 42, "pageLanguage": "ja", "translateStep": "idle"})
        self.assertEqual(out[1], ["2"], "only the module that mentions the store's action is loaded")

    def test_a_module_that_mentions_it_but_holds_no_store_is_passed_over(self):
        fake = """
          const require = (id) => ({ Z: { dispatch() {} } });
          require.m = { 7: function () { return "VIVALDI_TABS_LANGUAGE_DETERMINED"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertIsNone(js("(() => {" + fake + "return window.__vm.dia.findTranslation(chunks); })()"))

    def test_the_language_is_sent_in_the_translators_own_code(self):
        # measured on taobao.com (page says zh-CN): "zh-CN" and "auto" fail with unsupported_language, "zh-Hans" works;
        # Vivaldi's own popup converts with getTranslationCode, so the button does too
        code = "window.__vm.dia.translatorCode(lang, convert)"
        convert = "(c) => ({ 'zh-CN': 'zh-Hans' })[c] || c"
        self.assertEqual(js(f"(() => {{ const convert = {convert}; return {code}; }})()", lang="zh-CN"), "zh-Hans")
        self.assertEqual(js(f"(() => {{ const convert = {convert}; return {code}; }})()", lang="de"), "de")

    def test_without_vivaldis_converter_its_82_table_is_used(self):
        for page, sent in (("zh-CN", "zh-Hans"), ("zh-TW", "zh-Hant"), ("nb", "no"), ("iw", "he"), ("zh-Hans", "zh-Hans"), ("ja", "ja")):
            self.assertEqual(js("window.__vm.dia.translatorCode(lang, null)", lang=page), sent, page)

    def test_the_converter_comes_from_vivaldis_modules(self):
        fake = """
          const codes = { getTranslationCode: (c) => c === "zh-CN" ? "zh-Hans" : c, getTargetTranslationCode() {} };
          const require = (id) => id === "5" ? { Z: codes } : { Z: {} };
          require.m = { 4: function () { return "no"; }, 5: function () { return "getTranslationCode:"; } };
          const chunks = { push: ([ids, extra, run]) => run(require) };
        """
        self.assertEqual(js("(() => {" + fake + "return window.__vm.dia.findCodes(chunks)('zh-CN'); })()"), "zh-Hans")
        self.assertIsNone(js("window.__vm.dia.findCodes(undefined)"))

    def test_no_store_means_no_button_rather_than_an_error(self):
        self.assertIsNone(js("window.__vm.dia.findTranslation(undefined)"))
        self.assertIsNone(js("window.__vm.dia.findTranslation({ push: ([ids, extra, run]) => run(Object.assign(() => ({}), { m: {} })) })"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class SidebarButton(unittest.TestCase):
    """The button after Vivaldi's menu button hides and shows this window's sidebar (12-sidebar-hide.js); its tooltip
    always names Vivarc's own key, Ctrl+S (Cmd+S on a Mac)."""

    def label(self, shown, windows=True):
        return js("window.__vm.dia.sidebarLabel(shown, windows)", shown=shown, windows=windows)

    def test_the_tooltip_follows_the_state_and_names_vivarcs_key(self):
        self.assertEqual(self.label(True), "Hide sidebar (Ctrl+S)")
        self.assertEqual(self.label(False), "Show sidebar (Ctrl+S)")

    def test_on_a_mac_the_key_is_named_as_the_spaces_hint_names_it(self):
        self.assertEqual(self.label(True, windows=False), "Hide sidebar (Cmd+S)")
        self.assertEqual(self.label(False, windows=False), "Show sidebar (Cmd+S)")

    def test_the_button_no_longer_runs_vivaldis_toggle_command(self):
        source = open(os.path.join(os.path.dirname(__file__), "..", "src", "js", "15-dia.js"), encoding="utf-8").read()
        for gone in ("COMMAND_MAIN_TOGGLE_TAB_BAR", "findToggler", "executeActions", "vivaldi.tabs.visible"):
            self.assertNotIn(gone, source)


# One window of the module, running for real against fake Vivaldi prefs and profile store. The scenario (argv[2]):
# prefs and kept values to start from, the window, the saved setting (which arrives after start, as in Vivaldi),
# optionally the switch flipped afterwards (`then`), and a pref write that fails (`failAt`, 1-based).
HARNESS = r'''
const fs = require("fs"), vm = require("vm");
const sc = JSON.parse(process.argv[2]);
const sets = [], prefs = { ...sc.prefs }, stored = new Map(sc.kept ? [["dia:kept", sc.kept]] : []);
let release, listeners = [], writes = 0;
const node = () => ({ classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, style: { setProperty() {} }, remove() {} });
global.document = { body: node(), querySelector: () => null };
global.MutationObserver = class { observe() {} };
global.ResizeObserver = class { observe() {} unobserve() {} };
global.requestAnimationFrame = (fn) => fn();
global.chrome = { windows: { getCurrent: async () => ({ id: 1, ...sc.window }) },
  tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} }, onReplaced: { addListener() {} } } };
global.vivaldi = { prefs: { get: async (path) => ({ value: prefs[path] }), set: async ({ path, value }) => {
  if (++writes === sc.failAt) throw new Error("window closed");
  sets.push([path, value]); prefs[path] = value; } } };
let values = { diaLayout: false };  // the defaults, until the user's settings are in
global.window = { __vm: {
  windows: true, onMark() {}, ready: Promise.resolve(true),
  store: { get: async (key, fallback) => stored.get(key) ?? fallback, set: async (key, value) => stored.set(key, value) },
  settings: { all: () => ({ ...values }), onChange: (fn) => listeners.push(fn), loaded: new Promise((resolve) => { release = resolve; }) },
}, dispatchEvent() {}, innerWidth: 1000 };
global.console = { log() {}, warn() {} };
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
(async () => {
  await settle();
  values = { diaLayout: sc.dia };  // the user's saved setting arrives
  release();
  await settle();
  if (sc.then !== undefined) {
    values = { diaLayout: sc.then };
    listeners.forEach((fn) => fn({ ...values }));
    await settle();
  }
  process.stdout.write(JSON.stringify({ sets, prefs, kept: stored.get("dia:kept") ?? null }) + "\n");
})();
'''
NORMAL = {"type": "normal", "incognito": False}
ON = {ADDRESS: True, ROW: ["Back", "Forward", "Reload", "FlexibleSpacer", "Extensions"], FRAME: False}
KEPT = {ROW: USERS_ROW, FRAME: True}


def run(**scenario):
    import json
    import os
    import subprocess
    path = os.path.join(os.path.dirname(__file__), "..", "src", "js", "15-dia.js")
    out = subprocess.run(["node", "-e", HARNESS, path, json.dumps(scenario)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the Dia layout's JavaScript")
class Window(unittest.TestCase):
    def test_a_start_with_the_layout_on_never_switches_it_off_first(self):
        out = run(prefs=ON, kept=KEPT, window=NORMAL, dia=True)
        self.assertEqual(out["sets"], [], "already on: no pref is touched (switching off first would flash the frame and row)")

    def test_turning_it_off_puts_the_users_values_back_then_forgets_them(self):
        out = run(prefs=ON, kept=KEPT, window=NORMAL, dia=True, then=False)
        self.assertEqual(out["prefs"], ARC)
        self.assertIsNone(out["kept"])

    def test_a_restore_cut_short_keeps_the_users_values_for_the_next_window(self):
        out = run(prefs=ON, kept=KEPT, window=NORMAL, dia=True, then=False, failAt=1)
        self.assertEqual(out["kept"], KEPT)

    def test_private_popup_and_settings_windows_never_write_the_prefs(self):
        for window in ({"type": "normal", "incognito": True}, {"type": "popup", "incognito": False},
                       {**NORMAL, "vivExtData": '{"windowType":"settings"}'}):
            out = run(prefs=ON, kept=KEPT, window=window, dia=True, then=False)
            self.assertEqual(out["sets"], [], window)
            self.assertEqual(out["kept"], KEPT, window)


if __name__ == "__main__":
    unittest.main()
