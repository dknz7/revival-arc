import json
import os
import shutil
import subprocess
import unittest


@unittest.skipUnless(shutil.which("node"), "node is needed to test the theme editor")
class SpaceThemes(unittest.TestCase):
    def test_space_themes_are_independent_and_keep_the_existing_theme_as_fallback(self):
        script = r'''
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const events = {}, saved = new Map([["theme", { on: true, hue: 250, sat: 28, light: 20, grain: 30 }]]);
class Element {
  constructor() { this.children = []; this.listeners = {}; this.style = {}; this.className = ""; }
  append(...items) { this.children.push(...items); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  remove() {}
  contains() { return false; }
}
const props = {};
const browser = new Element();
browser.style = { setProperty: (k, v) => props[k] = v, removeProperty: (k) => delete props[k] };
browser.classList = { toggle() {} };
global.document = { querySelector: () => browser, createElement: () => new Element(), addEventListener() {}, body: browser };
global.window = {
  __vm: { store: { get: async (key, fallback) => saved.get(key) ?? fallback, set: async (key, value) => saved.set(key, value) },
    cssLoaded: true, onShortcut() {}, onMark() {} },
  addEventListener: (name, fn) => events[name] = fn,
};
global.BroadcastChannel = undefined;
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const switchTo = async (space) => { events["vm-active-space-changed"]({ detail: space }); await tick(); };
const open = async () => { events["vm-open-theme"](); await tick(); return browser.children.at(-1); };
(async () => {
  await switchTo(0);
  assert.equal(props["--vm-tint"], "hsl(250 28% 20%)");
  let pop = await open();
  pop.children[3].children[3].listeners.click(); // red preset
  assert.equal(saved.get("theme:space:0").hue, 355);
  await switchTo(42);
  assert.equal(props["--vm-tint"], "hsl(250 28% 20%)");
  pop = await open();
  pop.children[3].children[6].listeners.click(); // green preset
  assert.equal(saved.get("theme:space:42").hue, 143);
  await switchTo(0);
  assert.equal(props["--vm-tint"], "hsl(355 65% 62%)");
  pop = await open();
  pop.children.at(-1).listeners.click();
  assert.equal(saved.get("theme:space:0").on, false);
  assert.equal(saved.get("theme:space:42").hue, 143);
  await switchTo(42);
  assert.equal(props["--vm-tint"], "hsl(143 65% 65%)");
  assert.equal(saved.get("theme").hue, 250);
})().catch((error) => { console.error(error); process.exitCode = 1; });
'''
        path = os.path.join(os.path.dirname(__file__), "..", "src", "js", "40-theme.js")
        subprocess.run(["node", "-e", script, path], check=True, capture_output=True, text=True)

    def tiles(self, light):
        """The favorite tile color and opacity set for a space theme of this lightness."""
        script = r'''
const fs = require("fs"), vm = require("vm");
const events = {}, props = {};
const browser = { style: { setProperty: (k, v) => props[k] = v, removeProperty: (k) => delete props[k] }, classList: { toggle() {} } };
global.document = { querySelector: () => browser, addEventListener() {}, body: browser };
const theme = { on: true, hue: 120, sat: 50, light: Number(process.argv[2]), grain: 0 };
global.window = {
  __vm: { store: { get: async (key, fallback) => (key === "theme:space:0" ? theme : fallback), set: async () => {} },
    cssLoaded: true, onShortcut() {}, onMark() {} },
  addEventListener: (name, fn) => events[name] = fn,
};
global.BroadcastChannel = undefined;
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
events["vm-active-space-changed"]({ detail: 0 });
setImmediate(() => console.log(JSON.stringify([props["--vm-fav-color"], props["--vm-fav-opacity"]])));
'''
        path = os.path.join(os.path.dirname(__file__), "..", "src", "js", "40-theme.js")
        out = subprocess.run(["node", "-e", script, path, str(light)], check=True, capture_output=True, text=True)
        return json.loads(out.stdout)

    def test_favorite_tiles_stand_out_from_dark_pale_and_near_white_spaces(self):
        self.assertEqual(self.tiles(20), ["#fff", "16%"])     # dark: a faint light tile
        self.assertEqual(self.tiles(70), ["#fff", "46%"])     # pale color: a stronger light tile
        self.assertEqual(self.tiles(92), ["#1b1b1f", "20%"])  # near-white: a dark tile


if __name__ == "__main__":
    unittest.main()
