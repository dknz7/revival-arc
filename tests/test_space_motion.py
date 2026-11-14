"""The space-switch transition (41-space-motion.js): only a real change of the space on screen animates, never with Reduce
Motion, and a window's first look at its space does not."""
import shutil
import unittest

from jsrun import run_js


def wants(previous, next, reduced=False):
    return run_js("41-space-motion.js", "window.__vm.spaceMotion.wants({ previous, next, reduced })", previous=previous, next=next, reduced=reduced)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Transition(unittest.TestCase):
    def test_a_switch_animates(self):
        self.assertTrue(wants(0, 17))
        self.assertTrue(wants(17, 0))
        self.assertTrue(wants(17, 18))

    def test_reduce_motion_turns_it_off(self):
        self.assertFalse(wants(0, 17, reduced=True))

    def test_the_first_space_a_window_shows_does_not(self):
        self.assertFalse(wants(None, 17))

    def test_the_same_space_again_does_not(self):
        self.assertFalse(wants(17, 17))

    def test_it_is_short(self):
        self.assertEqual(run_js("41-space-motion.js", "[window.__vm.spaceMotion.SIDEBAR_MS, window.__vm.spaceMotion.PAGE_MS]"), [220, 180])


if __name__ == "__main__":
    unittest.main()
