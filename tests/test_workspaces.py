import json
import shutil
import unittest

from jsrun import run_js


def js(expr, **data):
    return run_js("07-workspaces.js", expr, **data)


def tab(id, workspace=None, index=0, active=False, accessed=None):
    t = {"id": id, "index": index, "active": active, "vivExtData": json.dumps({"workspaceId": workspace} if workspace else {})}
    if accessed is not None:
        t["lastAccessed"] = accessed
    return t


WORK = {"id": 1792776132092, "name": "Work", "emoji": "📚", "icon": "<svg/>"}
SIDE = {"id": 1792856044277, "name": "Side", "emoji": "🎁", "icon": "<svg/>"}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class WhichWindow(unittest.TestCase):
    """Every window's sidebar sees every window's tab events; only its own (or ones that do not say) re-render it."""

    EVENTS = {  # chrome.tabs event -> its arguments, all naming window 7
        "onCreated": [{"id": 1, "windowId": 7}],
        "onUpdated": [1, {"title": "x"}, {"id": 1, "windowId": 7}],
        "onActivated": [{"tabId": 1, "windowId": 7}],
        "onRemoved": [1, {"windowId": 7, "isWindowClosing": False}],
        "onMoved": [1, {"windowId": 7, "fromIndex": 0, "toIndex": 1}],
        "onAttached": [1, {"newWindowId": 7, "newPosition": 0}],
        "onDetached": [1, {"oldWindowId": 7, "oldPosition": 0}],
    }

    def test_each_tab_event_names_its_window(self):
        for ev, args in self.EVENTS.items():
            self.assertEqual(js("workspaces.eventWindow(ev, args)", ev=ev, args=args), 7, ev)

    def test_an_event_that_does_not_say_has_no_window(self):
        self.assertIsNone(js("workspaces.eventWindow('onReplaced', [2, 1])"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class WhichSpace(unittest.TestCase):
    def test_a_tab_belongs_to_the_workspace_vivaldi_stored_in_its_data(self):
        self.assertEqual(js("workspaces.of(t)", t=tab(1, WORK["id"])), WORK["id"])

    def test_a_tab_without_a_workspace_is_in_the_default_space(self):
        self.assertEqual(js("workspaces.of(t)", t=tab(1)), 0)
        self.assertEqual(js("workspaces.of({ vivExtData: 'not json' })"), 0)
        self.assertEqual(js("workspaces.of({})"), 0)

    def test_the_active_tab_decides_the_active_space(self):
        tabs = [tab(1, active=True), tab(2, WORK["id"]), tab(3, SIDE["id"])]
        self.assertEqual(js("workspaces.activeId(tabs)", tabs=tabs), 0)
        tabs = [tab(1), tab(2, WORK["id"], active=True)]
        self.assertEqual(js("workspaces.activeId(tabs)", tabs=tabs), WORK["id"])

    def test_without_an_active_tab_the_default_space_is_active(self):
        self.assertEqual(js("workspaces.activeId(tabs)", tabs=[tab(1, WORK["id"])]), 0)

    def test_tabs_in_a_space_are_only_that_spaces_tabs(self):
        tabs = [tab(1), tab(2, WORK["id"]), tab(3, SIDE["id"]), tab(4, WORK["id"])]
        self.assertEqual([t["id"] for t in js("workspaces.tabsIn(tabs, id)", tabs=tabs, id=WORK["id"])], [2, 4])
        self.assertEqual([t["id"] for t in js("workspaces.tabsIn(tabs, 0)", tabs=tabs)], [1])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Scope(unittest.TestCase):
    TABS = [tab(1, active=True), tab(2, WORK["id"]), tab(3, WORK["id"], index=1), tab(4, SIDE["id"])]

    def scope(self, tabs, workspaces):
        return js("workspaces.scope(tabs, list)", tabs=tabs, list=workspaces)

    def test_the_sidebar_shows_only_the_tabs_of_the_active_space(self):
        got = self.scope(self.TABS, [WORK, SIDE])
        self.assertEqual((got["active"], [t["id"] for t in got["tabs"]]), (0, [1]))
        tabs = [{**t, "active": t["id"] == 3} for t in self.TABS]
        got = self.scope(tabs, [WORK, SIDE])
        self.assertEqual((got["active"], [t["id"] for t in got["tabs"]]), (WORK["id"], [2, 3]))

    def test_when_the_workspace_list_is_unknown_every_tab_is_shown_so_nothing_looks_lost(self):
        got = self.scope(self.TABS, [])
        self.assertEqual((got["active"], [t["id"] for t in got["tabs"]]), (0, [1, 2, 3, 4]))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class SpaceList(unittest.TestCase):
    def items(self, workspaces):
        return js("workspaces.items(list, 'Home')", list=workspaces)

    def test_a_profile_without_workspaces_still_shows_home(self):
        self.assertEqual(self.items([]), [{"id": 0, "name": "Home", "emoji": ""}])
        self.assertEqual(js("workspaces.items(undefined, 'Home')"), [{"id": 0, "name": "Home", "emoji": ""}])

    def test_the_default_space_comes_first_followed_by_the_workspaces_in_vivaldis_order(self):
        items = self.items([WORK, SIDE])
        self.assertEqual([(i["id"], i["name"]) for i in items], [(0, "Home"), (WORK["id"], "Work"), (SIDE["id"], "Side")])

    def test_each_space_keeps_its_emoji_and_the_default_has_none(self):
        self.assertEqual([i["emoji"] for i in self.items([WORK])], ["", "📚"])

    def test_the_most_recently_used_tab_of_a_space_is_where_switching_goes(self):
        tabs = [tab(1, WORK["id"], accessed=100), tab(2, WORK["id"], accessed=300), tab(3, WORK["id"], accessed=200), tab(4, accessed=900)]
        self.assertEqual(js("workspaces.recentTab(tabs, id).id", tabs=tabs, id=WORK["id"]), 2)

    def test_without_access_times_the_last_tab_of_the_space_is_used(self):
        tabs = [tab(1, WORK["id"], index=0), tab(2, WORK["id"], index=5), tab(3, WORK["id"], index=2)]
        self.assertEqual(js("workspaces.recentTab(tabs, id).id", tabs=tabs, id=WORK["id"]), 2)

    def test_an_empty_space_has_no_tab_to_switch_to(self):
        self.assertIsNone(js("workspaces.recentTab(tabs, id)", tabs=[tab(1)], id=WORK["id"]))


def folder(id, title):
    return {"id": id, "title": title}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Folders(unittest.TestCase):
    def assign(self, folders, workspaces):
        return js("workspaces.assign(folders, list)", folders=folders, list=workspaces)

    def test_a_workspace_gets_the_pinned_folder_with_its_name_even_with_arcs_prefix_and_other_case(self):
        folders = [folder("a", "Vivarc"), folder("b", "Arc - work")]
        got = self.assign(folders, [WORK])
        self.assertEqual(got["byId"][str(WORK["id"])]["id"], "b")
        self.assertEqual(got["default"]["id"], "a")

    def test_the_default_space_is_the_first_folder_no_workspace_claims(self):
        folders = [folder("a", "Arc - Work"), folder("b", "Arc - Home"), folder("c", "Arc - Side")]
        got = self.assign(folders, [WORK, SIDE])
        self.assertEqual(got["default"]["id"], "b")
        self.assertEqual({k: v["id"] for k, v in got["byId"].items()}, {str(WORK["id"]): "a", str(SIDE["id"]): "c"})

    def test_a_workspace_without_a_folder_has_none_yet(self):
        got = self.assign([folder("a", "Vivarc")], [WORK])
        self.assertEqual(got["byId"], {})

    def test_with_no_workspaces_the_first_folder_is_the_default_as_before(self):
        self.assertEqual(self.assign([folder("a", "Vivarc"), folder("b", "Arc - Work")], [])["default"]["id"], "a")

    def test_one_folder_that_a_workspace_claims_still_serves_as_the_default(self):
        got = self.assign([folder("a", "Work")], [WORK])
        self.assertEqual(got["default"]["id"], "a")

    def test_without_any_folder_there_is_no_default(self):
        self.assertIsNone(self.assign([], [WORK])["default"])

    def test_the_label_drops_arcs_prefix(self):
        self.assertEqual(js("workspaces.label({ title: 'Arc - Home' })"), "Home")
        self.assertEqual(js("workspaces.label({ title: 'Vivarc' })"), "Vivarc")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class NewTabs(unittest.TestCase):
    def stamped(self, t, active, window=1):
        out = js("workspaces.stamp(t, active, window)", t=t, active=active, window=window)
        return json.loads(out) if out else None

    def test_a_tab_opened_while_a_space_is_active_joins_that_space(self):
        self.assertEqual(self.stamped({**tab(1), "windowId": 1}, WORK["id"]), {"workspaceId": WORK["id"]})

    def test_a_tab_opened_in_another_window_is_left_to_that_window(self):
        t = {**tab(1), "windowId": 2}
        self.assertIsNone(self.stamped(t, WORK["id"], window=1))
        self.assertEqual(self.stamped({**tab(1), "windowId": 1}, WORK["id"], window=1), {"workspaceId": WORK["id"]})

    def test_the_tabs_other_data_is_kept(self):
        t = {"id": 1, "windowId": 1, "vivExtData": json.dumps({"tiling": {"id": "t"}})}
        self.assertEqual(self.stamped(t, WORK["id"]), {"tiling": {"id": "t"}, "workspaceId": WORK["id"]})

    def test_nothing_is_written_in_the_default_space(self):
        self.assertIsNone(self.stamped({**tab(1), "windowId": 1}, 0))

    def test_a_tab_that_already_has_a_workspace_is_left_alone(self):
        self.assertIsNone(self.stamped({**tab(1, SIDE["id"]), "windowId": 1}, WORK["id"]))
        self.assertIsNone(self.stamped({"id": 1, "windowId": 1, "vivExtData": json.dumps({"workspaceId": 0})}, WORK["id"]))

    # A tab a page opens (middle-click, ctrl+click) belongs with that page. The sidebar's idea of the active space
    # comes from a debounced refresh and can lag by seconds while pages load; the opener cannot.
    def stamped_from(self, t, active, opener, window=1):
        out = js("workspaces.stamp(t, active, window, opener)", t=t, active=active, window=window, opener=opener)
        return json.loads(out) if out else None

    def test_a_link_from_a_default_space_page_stays_there_even_while_the_sidebar_lags_on_another_space(self):
        opener = {**tab(9), "windowId": 1}
        self.assertIsNone(self.stamped_from({**tab(1), "windowId": 1}, WORK["id"], opener))

    def test_a_link_from_a_page_in_a_space_joins_that_space_not_the_one_the_sidebar_last_saw(self):
        opener = {**tab(9, SIDE["id"]), "windowId": 1}
        self.assertEqual(self.stamped_from({**tab(1), "windowId": 1}, WORK["id"], opener), {"workspaceId": SIDE["id"]})
        self.assertEqual(self.stamped_from({**tab(1), "windowId": 1}, 0, opener), {"workspaceId": SIDE["id"]})

    def test_an_opener_in_another_window_does_not_decide(self):
        opener = {**tab(9, SIDE["id"]), "windowId": 2}
        self.assertEqual(self.stamped_from({**tab(1), "windowId": 1}, WORK["id"], opener), {"workspaceId": WORK["id"]})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class NewTabsGoFirst(unittest.TestCase):
    """A new tab (Ctrl+T, + New Tab) goes to the top of its space's list, as in Arc. The list shows the highest tab
    index first (stacks.entries), so the top is the space's highest index."""

    def top(self, tabs, me):
        return js("workspaces.topIndex(tabs, me)", tabs=tabs, me=me)

    def win(self, id, index, workspace=None, pinned=False, window=1):
        return {**tab(id, workspace, index=index), "windowId": window, "pinned": pinned}

    def test_it_goes_where_its_spaces_last_tab_is_which_the_list_shows_first(self):
        tabs = [self.win(1, 0), self.win(4, 1), self.win(2, 2), self.win(3, 3), self.win(5, 4, WORK["id"])]
        self.assertEqual(self.top(tabs, tabs[1]), 3)

    def test_other_spaces_tabs_do_not_count(self):
        tabs = [self.win(1, 0, WORK["id"]), self.win(2, 1, WORK["id"]), self.win(3, 2, SIDE["id"]), self.win(4, 3, SIDE["id"])]
        self.assertEqual(self.top(tabs, tabs[0]), 1)

    def test_a_pinned_tab_does_not_count(self):
        tabs = [self.win(1, 0), self.win(2, 1), self.win(3, 2, pinned=True)]
        self.assertEqual(self.top(tabs, tabs[0]), 1)

    def test_a_tab_already_at_the_top_stays(self):
        tabs = [self.win(1, 0), self.win(2, 1), self.win(3, 2, SIDE["id"])]
        self.assertIsNone(self.top(tabs, tabs[1]))

    def test_the_only_tab_of_its_space_stays(self):
        tabs = [self.win(1, 0, SIDE["id"]), self.win(2, 1)]
        self.assertIsNone(self.top(tabs, tabs[1]))

    def test_tabs_in_other_windows_do_not_count(self):
        tabs = [self.win(1, 0), self.win(2, 1), self.win(3, 5, window=2)]
        self.assertEqual(self.top(tabs, tabs[0]), 1)


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class CreateSpace(unittest.TestCase):
    def test_the_hint_names_the_key_the_install_binds_to_create_workspace(self):
        import vivarc
        names = {"ctrl": "Ctrl", "meta": "Cmd", "alt": "Option", "shift": "Shift"}
        shown = "+".join(names.get(k, k.upper()) for k in vivarc.SPACE_KEYS["COMMAND_WORKSPACE_CREATE_NEW"].split("+"))
        self.assertEqual(js("workspaces.CREATE_HINT"), f"Press {shown} to create a space")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class DeleteSpace(unittest.TestCase):
    FAKE = """
      const calls = [];
      const manager = new (class { removeWorkspace(windowId, id) { calls.push([windowId, id]); return "done"; } })();
      const modules = {
        1: function () { return "nothing to see"; },
        2: function () { return "workspaces.removeWorkspace(e,t)"; },
        3: function () { throw new Error("module 3 must not be loaded"); },
      };
      const exportsOf = { 2: Object.defineProperty({}, "Z", { enumerable: true, get: () => manager }) };
      const require = (id) => { if (!(id in exportsOf)) throw new Error("not loaded: " + id); return exportsOf[id]; };
      require.m = modules;
      const chunks = { push: ([ids, extra, run]) => run(require) };
    """

    def fake(self, body):
        return js("(() => {" + self.FAKE + body + "})()")

    def test_the_remover_is_found_in_vivaldis_own_modules_and_removes_the_workspace(self):
        out = self.fake("const remove = workspaces.findRemover(chunks); return [typeof remove, remove(7, 42), calls];")
        self.assertEqual(out, ["function", "done", [[7, 42]]])

    def test_modules_that_do_not_mention_the_remover_are_never_loaded(self):
        self.assertEqual(self.fake("workspaces.findRemover(chunks); return calls;"), [])

    def test_no_remover_when_vivaldi_has_no_such_module(self):
        self.assertIsNone(js("workspaces.findRemover({ push: ([a, b, run]) => run(Object.assign(() => ({}), { m: { 1: function () {} } })) })"))

    def test_no_remover_when_the_chunk_list_is_missing_or_broken(self):
        self.assertIsNone(js("workspaces.findRemover(undefined)"))
        self.assertIsNone(js("workspaces.findRemover({ push: () => { throw new Error('boom'); } })"))

    def test_the_delete_button_names_the_space_and_counts_its_tabs(self):
        self.assertEqual(js("workspaces.removalLabel('Work', 5)"), "Delete \u201cWork\u201d and close its 5 tabs")
        self.assertEqual(js("workspaces.removalLabel('Work', 1)"), "Delete \u201cWork\u201d and close its 1 tab")
        self.assertEqual(js("workspaces.removalLabel('Work', 0)"), "Delete \u201cWork\u201d")


class CreateSpaceDialog(unittest.TestCase):
    def test_opens_native_dialog_in_the_requested_window(self):
        fake = DeleteSpace.FAKE.replace("removeWorkspace", "showWorkspaceDialog")
        out = js("(() => {" + fake + "const create = workspaces.findCreator(chunks); create(7); return calls; })()")
        self.assertEqual(out, [[7, {"createInBackground": False}]])

    def test_missing_native_api_returns_no_creator(self):
        self.assertIsNone(js("workspaces.findCreator(undefined)"))


class SwitchSpace(unittest.TestCase):
    def test_switches_to_new_empty_workspace_through_native_action(self):
        fake = DeleteSpace.FAKE.replace("removeWorkspace", "setActiveWorkspace")
        self.assertEqual(js("(() => {" + fake + "workspaces.findSwitcher(chunks)(7, 42); return calls; })()"), [[7, 42]])

    def test_home_uses_native_undefined_workspace_id(self):
        fake = DeleteSpace.FAKE.replace("removeWorkspace", "setActiveWorkspace")
        self.assertEqual(js("(() => {" + fake + "workspaces.findSwitcher(chunks)(7, 0); return calls; })()"), [[7, None]])

    def test_no_switcher_when_native_modules_are_missing(self):
        self.assertIsNone(js("workspaces.findSwitcher(undefined)"))


def active_in(window_id, workspace=None, id=None):
    t = tab(id or window_id * 10, workspace, active=True)
    t["windowId"] = window_id
    return t


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class Elsewhere(unittest.TestCase):
    """Vivaldi keeps a named space in one window at a time: a click on one open elsewhere jumps to that window."""

    def elsewhere(self, active_tabs, window_id):
        return js("workspaces.elsewhere(tabs, me)", tabs=active_tabs, me=window_id)

    def test_a_space_active_in_another_window_is_mapped_to_that_window(self):
        found = self.elsewhere([active_in(1, WORK["id"]), active_in(2, SIDE["id"])], 1)
        self.assertEqual(found, {str(SIDE["id"]): 2})

    def test_this_windows_own_space_is_not_elsewhere(self):
        self.assertEqual(self.elsewhere([active_in(1, WORK["id"])], 1), {})

    def test_the_default_space_is_never_elsewhere_because_every_window_has_its_own(self):
        self.assertEqual(self.elsewhere([active_in(1, WORK["id"]), active_in(2), active_in(3)], 1), {})

    def test_no_windows_means_nothing_elsewhere(self):
        self.assertEqual(self.elsewhere([], 1), {})


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class TileHint(unittest.TestCase):
    def hint(self, item, elsewhere=None, windows=True):
        return js("workspaces.tileHint(item, elsewhere, windows)", item=item, elsewhere=elsewhere or {}, windows=windows)

    def test_a_space_says_how_to_move_it_to_a_new_window(self):
        self.assertEqual(self.hint({"id": WORK["id"], "name": "Work"}), "Work · ctrl+shift+click to move it to a new window")

    def test_on_a_mac_it_is_cmd_because_ctrl_click_is_a_right_click_there(self):
        self.assertEqual(self.hint({"id": WORK["id"], "name": "Work"}, windows=False),
                         "Work · cmd+shift+click to move it to a new window")

    def test_the_default_space_says_it_is_this_windows_own(self):
        self.assertEqual(self.hint({"id": 0, "name": "DKNZLIFE"}), "DKNZLIFE · this window's own tabs")

    def test_a_space_open_in_another_window_says_what_each_click_does(self):
        hint = self.hint({"id": SIDE["id"], "name": "Side"}, {str(SIDE["id"]): 2})
        self.assertEqual(hint, "Side · open in another window. Click to go there, shift+click to bring it here, "
                               "ctrl+shift+click to move it to a new window")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class NewWindowClick(unittest.TestCase):
    """ctrl+shift+click sends a space to a new window; cmd+shift+click on a Mac, where ctrl+click is a right-click."""

    def wants(self, windows, **keys):
        event = {"shiftKey": False, "ctrlKey": False, "metaKey": False, "altKey": False, **keys}
        return js("workspaces.wantsNewWindow(event, windows)", event=event, windows=windows)

    def test_ctrl_shift_on_windows(self):
        self.assertTrue(self.wants(True, ctrlKey=True, shiftKey=True))
        self.assertFalse(self.wants(True, metaKey=True, shiftKey=True))

    def test_cmd_shift_on_a_mac(self):
        self.assertTrue(self.wants(False, metaKey=True, shiftKey=True))
        self.assertFalse(self.wants(False, ctrlKey=True, shiftKey=True))

    def test_plain_shift_and_ctrl_clicks_are_left_to_the_other_actions(self):
        for windows in (True, False):
            self.assertFalse(self.wants(windows))
            self.assertFalse(self.wants(windows, shiftKey=True))
            self.assertFalse(self.wants(windows, ctrlKey=True))
            self.assertFalse(self.wants(windows, metaKey=True))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class WhereActive(unittest.TestCase):
    """The window a space is active in, this one included (elsewhere leaves this window out)."""

    def where(self, active_tabs, space):
        return js("workspaces.activeWindowOf(tabs, id)", tabs=active_tabs, id=space)

    def test_the_window_whose_active_tab_is_in_the_space(self):
        self.assertEqual(self.where([active_in(1, WORK["id"]), active_in(2, SIDE["id"])], SIDE["id"]), 2)
        self.assertEqual(self.where([active_in(1, WORK["id"]), active_in(2, SIDE["id"])], WORK["id"]), 1)

    def test_a_space_active_nowhere_has_no_window(self):
        self.assertIsNone(self.where([active_in(1, WORK["id"])], SIDE["id"]))
        self.assertIsNone(self.where([], SIDE["id"]))


if __name__ == "__main__":
    unittest.main()
