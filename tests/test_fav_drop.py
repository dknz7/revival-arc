"""A drop in a gap of the favorites grid lands beside the nearest tile (09-fav-drop.js)."""
import shutil
import unittest

from jsrun import run_js

# a grid of 3 tiles per row, 40 px apart, tile middles at x 20, 60, 100 and y 20, 60
GRID = [{"x": x, "y": y} for y in (20, 60) for x in (20, 60, 100)]


def slot(at, centers=GRID):
    return run_js("09-fav-drop.js", "window.__vm.favDrop.slot(centers, at)", centers=centers, at=at)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class GapDrop(unittest.TestCase):
    def test_between_two_tiles_it_goes_beside_the_nearer_on_the_pointers_side(self):
        self.assertEqual(slot({"x": 38, "y": 20}), {"index": 0, "after": True})   # nearer the first, right of its middle
        self.assertEqual(slot({"x": 44, "y": 20}), {"index": 1, "after": False})  # nearer the second, left of its middle

    def test_past_the_end_of_a_row_it_goes_after_that_rows_last_tile(self):
        self.assertEqual(slot({"x": 130, "y": 22}), {"index": 2, "after": True})

    def test_the_start_of_the_second_row(self):
        self.assertEqual(slot({"x": 2, "y": 58}), {"index": 3, "after": False})

    def test_a_gap_between_rows_takes_the_nearer_row(self):
        self.assertEqual(slot({"x": 61, "y": 45}), {"index": 4, "after": True})

    def test_no_tiles_no_slot(self):
        self.assertIsNone(slot({"x": 1, "y": 1}, centers=[]))
        self.assertIsNone(run_js("09-fav-drop.js", "window.__vm.favDrop.slot([{ x: 1, y: 1 }], null)"))


if __name__ == "__main__":
    unittest.main()
