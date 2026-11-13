import shutil
import unittest

from jsrun import run_js


def js(expr, **data):
    return run_js("01-settings.js", expr, **data)


def resolve(config=None, saved=None):
    return js("settings.resolve(settings.SCHEMA, config, saved)", config=config or {}, saved=saved or {})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Resolve(unittest.TestCase):
    def test_without_anything_saved_the_defaults_apply(self):
        self.assertEqual(resolve(), {"showUrl": True, "glass": False, "glassOpacity": 55, "spaceBar": True, "compactBottomBar": True, "searchSuggestions": True, "diaLayout": False, "cleanupDaily": False})

    def test_the_install_config_sets_the_starting_point(self):
        values = resolve(config={"compactBottomBar": False, "suggestions": "off"})
        self.assertFalse(values["compactBottomBar"])
        self.assertFalse(values["searchSuggestions"])

    def test_what_the_user_saved_wins_over_the_install_config(self):
        values = resolve(config={"compactBottomBar": False}, saved={"compactBottomBar": True, "spaceBar": False})
        self.assertTrue(values["compactBottomBar"])
        self.assertFalse(values["spaceBar"])

    def test_a_saved_value_of_the_wrong_type_or_an_unknown_key_is_ignored(self):
        values = resolve(saved={"spaceBar": "no", "nonsense": True})
        self.assertTrue(values["spaceBar"])
        self.assertNotIn("nonsense", values)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class GlassOpacity(unittest.TestCase):
    def test_a_saved_opacity_is_used(self):
        self.assertEqual(resolve(saved={"glassOpacity": 80})["glassOpacity"], 80)

    def test_an_opacity_outside_the_range_is_pulled_back_in(self):
        self.assertEqual(resolve(saved={"glassOpacity": 5})["glassOpacity"], 15)
        self.assertEqual(resolve(saved={"glassOpacity": 400})["glassOpacity"], 95)

    def test_something_that_is_not_a_number_is_ignored(self):
        self.assertEqual(resolve(saved={"glassOpacity": "high"})["glassOpacity"], 55)
        self.assertEqual(resolve(saved={"glassOpacity": True})["glassOpacity"], 55)

    def test_the_opacity_becomes_a_css_variable_in_percent(self):
        out = js("settings.vars(settings.SCHEMA, values)", values={"glassOpacity": 72})
        self.assertEqual(out, {"--vm-glass-opacity": "72%"})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class MarkerClasses(unittest.TestCase):
    def classes(self, values):
        return js("settings.classes(settings.SCHEMA, values)", values=values)

    def test_compact_bottom_bar_is_a_class_while_on(self):
        self.assertTrue(self.classes({"compactBottomBar": True})["vm-compact-bottom"])
        self.assertFalse(self.classes({"compactBottomBar": False})["vm-compact-bottom"])

    def test_liquid_glass_is_a_class_while_on_and_off_by_default(self):
        self.assertTrue(self.classes({"glass": True})["vm-glass"])
        self.assertFalse(self.classes({"glass": False})["vm-glass"])
        self.assertFalse(resolve()["glass"])

    def test_hiding_the_space_bar_is_a_class_while_it_is_off(self):
        self.assertTrue(self.classes({"spaceBar": False})["vm-no-space-bar"])
        self.assertFalse(self.classes({"spaceBar": True})["vm-no-space-bar"])


CORE_HARNESS = r"""
const fs = require("fs"), vm = require("vm"), path = require("path");
const warns = [];
let shortcut = null;
global.console = { log() {}, warn: (...a) => warns.push(a.map(String).join(" ")) };
global.indexedDB = { open: () => ({}) };
global.vivaldi = { tabsPrivate: { onKeyboardShortcut: { addListener: (fn) => { shortcut = fn; } } } };
global.document = { querySelector: () => null, documentElement: {} };
global.MutationObserver = class { observe() {} disconnect() {} };
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(process.argv[1], "00-core.js"), "utf8"));
const heard = [];
window.__vm.onShortcut((key) => heard.push(["first", key]));
window.__vm.onShortcut(() => { throw new Error("broken subscriber"); });
window.__vm.onShortcut((key, combo, win) => heard.push(["third", key, win]));
shortcut("ctrl+l", 7);
shortcut("f6", 7);
process.stdout.write(JSON.stringify({ heard, warns }));
"""


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class ShortcutSubscribers(unittest.TestCase):
    """00-core.js hands every key to every module that subscribed; one that throws must not keep it from the rest."""

    def test_a_subscriber_that_throws_does_not_stop_the_others_and_is_warned_once(self):
        import json
        import os
        import subprocess
        from jsrun import JS_DIR
        out = json.loads(subprocess.run(["node", "-e", CORE_HARNESS, os.path.abspath(JS_DIR)], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(out["heard"], [["first", "ctrl+l"], ["third", "ctrl+l", 7], ["first", "f6"], ["third", "f6", 7]])
        self.assertEqual(len([w for w in out["warns"] if "shortcut subscriber" in w]), 1, out["warns"])


if __name__ == "__main__":
    unittest.main()
