import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jsrun import run_js  # noqa: E402

MODULE = "14-panel-edge.js"


def at_edge(x, y, width=2560, height=1382, buttons=0):
    return run_js(MODULE, "window.__vm.panelEdge.atEdge({ x, y, width, height, buttons })", x=x, y=y, width=width, height=height, buttons=buttons)


def wanted(**state):
    base = {"wrapper": True, "holdsPanel": True, "shown": False, "fullscreen": False}
    return run_js(MODULE, "window.__vm.panelEdge.wanted(state)", state={**base, **state})


def steps(moves):
    """moves: [(here, ms)] in order; returns whether each was an arrival."""
    return run_js(MODULE, """(() => { let memo = { inside: false, lastAt: 0 }; return moves.map(([here, now]) => {
        const r = window.__vm.panelEdge.step(memo, here, now); memo = r.memo; return r.arrived; }); })()""", moves=moves)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the panel edge's JavaScript")
class TheEdge(unittest.TestCase):
    """Vivaldi's right-hand panel reveals from the window's right edge, read in this window's own coordinates only: the last
    10 px (Vivaldi's reach in a window that is not maximised), away from Vivaldi's 34 px dead corners, no button held."""

    def test_the_last_pixels_of_the_window_are_the_edge(self):
        self.assertTrue(at_edge(2559, 700))
        self.assertTrue(at_edge(2550, 700))

    def test_further_in_is_not(self):
        self.assertFalse(at_edge(2549, 700))
        self.assertFalse(at_edge(1280, 700))

    def test_outside_the_window_is_not(self):
        self.assertFalse(at_edge(2560, 700))

    def test_the_dead_corners_are_not(self):
        self.assertFalse(at_edge(2559, 0))
        self.assertFalse(at_edge(2559, 33))
        self.assertTrue(at_edge(2559, 34))
        self.assertTrue(at_edge(2559, 1382 - 35))
        self.assertFalse(at_edge(2559, 1382 - 34))

    def test_a_drag_is_not(self):
        self.assertFalse(at_edge(2559, 700, buttons=1))

    def test_it_is_the_same_on_any_monitor(self):
        # Client coordinates only: the window's position on the desktop is not an input at all.
        self.assertTrue(at_edge(1483, 500, width=1484, height=992))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the panel edge's JavaScript")
class WhenItReveals(unittest.TestCase):
    """Only with the panel on the right and auto-hidden, not already showing, the window not full screen."""

    def test_a_hidden_right_hand_panel_reveals(self):
        self.assertTrue(wanted())

    def test_no_right_hand_auto_hide_no_reveal(self):
        self.assertFalse(wanted(wrapper=False))  # pinned, or on the left

    def test_the_right_side_holding_something_else_is_not_ours(self):
        self.assertFalse(wanted(holdsPanel=False))

    def test_already_showing_or_full_screen(self):
        self.assertFalse(wanted(shown=True))
        self.assertFalse(wanted(fullscreen=True))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the panel edge's JavaScript")
class OncePerArrival(unittest.TestCase):
    """Vivaldi reports the edge once per arrival; so does Vivarc. Moves over the page are not heard, so a pause of more
    than a second at the edge counts as a new arrival."""

    def test_moving_along_the_edge_is_one_arrival(self):
        self.assertEqual(steps([[True, 1000], [True, 1050], [True, 1100]]), [True, False, False])

    def test_leaving_and_coming_back_is_a_second_arrival(self):
        self.assertEqual(steps([[True, 1000], [False, 1100], [True, 1200]]), [True, False, True])

    def test_a_pause_at_the_edge_is_a_new_arrival(self):
        self.assertEqual(steps([[True, 1000], [True, 1900], [True, 3000]]), [True, False, True])

    def test_moves_off_the_edge_never_arrive(self):
        self.assertEqual(steps([[False, 1000], [False, 5000]]), [False, False])


if __name__ == "__main__":
    unittest.main()
