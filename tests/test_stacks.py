import json
import shutil
import unittest

from jsrun import run_js


def js(expr, **data):
    return run_js("09-stacks.js", expr, **data)


def tab(id, index, group=None, title=None, active=False):
    ext = {}
    if group:
        ext["group"] = group
    if title:
        ext["fixedGroupTitle"] = title
    return {"id": id, "index": index, "active": active, "title": f"Tab {id}", "url": f"https://{id}.test/", "vivExtData": json.dumps(ext)}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Folders(unittest.TestCase):
    """Vivaldi tab stacks shown as folders in the sidebar's tab list (highest tab index first, as the list is)."""

    def entries(self, tabs):
        out = js("window.__vm.stacks.entries(tabs)", tabs=tabs)
        return [e["tab"]["id"] if e["type"] == "tab" else (e["id"], [t["id"] for t in e["tabs"]]) for e in out]

    def test_tabs_of_one_stack_become_one_folder_where_its_top_tab_is(self):
        tabs = [tab(1, 0), tab(2, 1, "s"), tab(3, 2, "s"), tab(4, 3)]
        self.assertEqual(self.entries(tabs), [4, ("s", [2, 3]), 1])

    def test_a_folder_sits_where_its_top_tab_is_even_when_its_tabs_are_apart(self):
        tabs = [tab(1, 1, "s"), tab(2, 2), tab(3, 3, "s")]
        self.assertEqual(self.entries(tabs), [("s", [1, 3]), 2])

    def test_a_stack_of_one_tab_is_just_a_tab(self):
        # Vivaldi shows a stack only from two tabs: one left over is a plain tab
        self.assertEqual(self.entries([tab(1, 0, "s"), tab(2, 1)]), [2, 1])

    def test_a_folder_lists_its_tabs_in_tab_order(self):
        out = js("window.__vm.stacks.entries(tabs)", tabs=[tab(3, 5, "s"), tab(2, 4, "s")])
        self.assertEqual([t["id"] for t in out[0]["tabs"]], [2, 3])

    def test_a_folder_is_named_by_vivaldis_stack_title(self):
        self.assertEqual(js("window.__vm.stacks.titleOf(tabs)", tabs=[tab(1, 0, "s"), tab(2, 1, "s", "Research")]), "Research")
        self.assertEqual(js("window.__vm.stacks.titleOf(tabs)", tabs=[tab(1, 0, "s"), tab(2, 1, "s")]), "Folder")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Drops(unittest.TestCase):
    """What dropping a dragged tab does: onto a tab or a folder's middle groups it, above or below moves it."""

    def drop(self, dragged, target, zone, shown=("s",)):
        return js("window.__vm.stacks.dropAction(dragged, target, zone, shown)", dragged=dragged, target=target, zone=zone,
                  shown=list(shown))

    def test_a_tab_onto_a_loose_tab_makes_a_new_folder_of_both(self):
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1)}, "into"), {"op": "create", "with": 2})

    def test_a_tab_onto_a_tab_in_a_folder_joins_that_folder(self):
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1, "s")}, "into"), {"op": "join", "stack": "s"})

    def test_a_tab_onto_a_folder_joins_it(self):
        self.assertEqual(self.drop(tab(1, 0), {"stack": "s"}, "into"), {"op": "join", "stack": "s"})

    def test_a_tab_already_in_the_folder_dropped_onto_it_stays(self):
        self.assertEqual(self.drop(tab(1, 0, "s"), {"stack": "s"}, "into"), {"op": "none"})
        self.assertEqual(self.drop(tab(1, 0, "s"), {"tab": tab(2, 1, "s")}, "into"), {"op": "none"})

    def test_a_folders_tab_moved_beside_a_loose_tab_leaves_the_folder(self):
        self.assertEqual(self.drop(tab(1, 0, "s"), {"tab": tab(2, 1)}, "before"), {"op": "leave"})
        self.assertEqual(self.drop(tab(1, 0, "s"), {"stack": "s"}, "after"), {"op": "leave"})

    def test_a_tab_moved_within_its_folder_or_among_loose_tabs_only_moves(self):
        self.assertEqual(self.drop(tab(1, 0, "s"), {"tab": tab(2, 1, "s")}, "after"), {"op": "move"})
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1)}, "after"), {"op": "move"})

    def test_a_loose_tab_beside_a_folders_head_moves_but_between_its_tabs_joins(self):
        self.assertEqual(self.drop(tab(1, 0), {"stack": "s"}, "before"), {"op": "move"})
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1, "s")}, "before"), {"op": "join", "stack": "s"})

    def test_a_tab_onto_itself_does_nothing(self):
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(1, 0)}, "into"), {"op": "none"})

    def test_a_stack_id_on_a_tab_shown_loose_counts_for_nothing(self):
        # Vivaldi can leave an id on a tab it shows loose: beside it is a plain move, onto it a new folder
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1, "gone")}, "before"), {"op": "move"})
        self.assertEqual(self.drop(tab(1, 0, "gone"), {"tab": tab(2, 1)}, "after"), {"op": "move"})
        self.assertEqual(self.drop(tab(1, 0), {"tab": tab(2, 1, "gone")}, "into"), {"op": "create", "with": 2})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Placement(unittest.TestCase):
    """Where a tab moved beside another lands; the list shows the highest index first."""

    def beside(self, moving, tab_, zone):
        return js("window.__vm.stacks.indexBeside(m, t, z)", m=moving, t=tab_, z=zone)

    def test_above_and_below_a_tab_from_either_side(self):
        self.assertEqual(self.beside(tab(1, 0), tab(2, 3), "before"), 3)
        self.assertEqual(self.beside(tab(1, 0), tab(2, 3), "after"), 2)
        self.assertEqual(self.beside(tab(1, 5), tab(2, 3), "before"), 4)
        self.assertEqual(self.beside(tab(1, 5), tab(2, 3), "after"), 3)

    def test_beside_itself_it_stays_where_it_is(self):
        # a folder's top tab dragged just above its own head
        self.assertEqual(self.beside(tab(1, 2), tab(1, 2), "before"), 2)
        self.assertEqual(self.beside(tab(1, 2), tab(1, 2), "after"), 2)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Ungroup(unittest.TestCase):
    """Vivaldi ungroups only tabs it really moves (measured on 8.2: right over the next tab takes start + count, left start - 1)."""

    def nudge(self, start, count, total):
        return js("window.__vm.stacks.nudge(start, count, total)", start=start, count=count, total=total)

    def test_a_folder_with_tabs_after_it_steps_over_the_next_tab(self):
        # measured: [com*, org*, net] to 1 is "nothing to move"; to 2 gives [net, com, org], net then back to 2
        self.assertEqual(self.nudge(0, 2, 3), {"target": 2, "neighbour": 2})

    def test_a_folder_at_the_end_of_the_window_steps_back_over_the_tab_before(self):
        # seen live: [org, com*, net*] moved to 2 is "nothing to move"; to 0 gives [com, net, org], org back to 0
        self.assertEqual(self.nudge(1, 2, 3), {"target": 0, "neighbour": 0})

    def test_a_folder_that_is_the_whole_window_has_nowhere_to_go(self):
        self.assertIsNone(self.nudge(0, 2, 2))


if __name__ == "__main__":
    unittest.main()
