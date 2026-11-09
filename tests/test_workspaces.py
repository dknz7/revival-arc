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
        self.assertEqual(js("workspaces.removalLabel('Work', 5, 1, false)"), "Delete \u201cWork\u201d and close its 5 tabs")
        self.assertEqual(js("workspaces.removalLabel('Work', 1, 1, false)"), "Delete \u201cWork\u201d and close its 1 tab")
        self.assertEqual(js("workspaces.removalLabel('Work', 0, 0, false)"), "Delete \u201cWork\u201d")

    def test_the_delete_button_says_when_the_tabs_span_windows(self):
        self.assertEqual(js("workspaces.removalLabel('Work', 5, 2, false)"), "Delete \u201cWork\u201d and close its 5 tabs in 2 windows")

    def test_the_delete_button_says_when_a_window_closes_too(self):
        self.assertEqual(js("workspaces.removalLabel('Work', 3, 1, true)"), "Delete \u201cWork\u201d and close its 3 tabs. A window holding only these tabs closes too")

    def test_the_delete_button_says_both_in_order(self):
        self.assertEqual(js("workspaces.removalLabel('Work', 4, 3, true)"), "Delete \u201cWork\u201d and close its 4 tabs in 3 windows. A window holding only these tabs closes too")

    def test_the_delete_button_stays_plain_without_tabs(self):
        self.assertEqual(js("workspaces.removalLabel('Work', 0, 0, true)"), "Delete \u201cWork\u201d")

    def test_removal_scope_counts_tabs_and_windows(self):
        tabs = [dict(tab(1, WORK["id"]), windowId=1), dict(tab(2, WORK["id"]), windowId=1),
                dict(tab(3, WORK["id"]), windowId=2), dict(tab(4, SIDE["id"]), windowId=2)]
        self.assertEqual(js("workspaces.removalScope(tabs, id)", tabs=tabs, id=WORK["id"]),
                         {"tabCount": 3, "windowCount": 2, "closesWindow": True})

    def test_a_window_with_other_spaces_tabs_does_not_close(self):
        tabs = [dict(tab(1, WORK["id"]), windowId=1), dict(tab(2, SIDE["id"]), windowId=1)]
        self.assertEqual(js("workspaces.removalScope(tabs, id)", tabs=tabs, id=WORK["id"]),
                         {"tabCount": 1, "windowCount": 1, "closesWindow": False})

    def test_no_tabs_means_no_scope(self):
        self.assertEqual(js("workspaces.removalScope([], 5)"), {"tabCount": 0, "windowCount": 0, "closesWindow": False})
        self.assertEqual(js("workspaces.removalScope(null, 5)"), {"tabCount": 0, "windowCount": 0, "closesWindow": False})


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


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class TileHint(unittest.TestCase):
    def hint(self, item, elsewhere=False, windows=True):
        return js("workspaces.tileHint(item, elsewhere, windows)", item=item, elsewhere=elsewhere, windows=windows)

    def test_a_space_says_how_to_move_it_to_a_new_window(self):
        self.assertEqual(self.hint({"id": WORK["id"], "name": "Work"}), "Work · ctrl+shift+click to move it to a new window")

    def test_on_a_mac_it_is_cmd_because_ctrl_click_is_a_right_click_there(self):
        self.assertEqual(self.hint({"id": WORK["id"], "name": "Work"}, windows=False),
                         "Work · cmd+shift+click to move it to a new window")

    def test_the_default_space_says_it_is_this_windows_own(self):
        self.assertEqual(self.hint({"id": 0, "name": "DKNZLIFE"}), "DKNZLIFE · this window's own tabs")

    def test_a_space_open_in_another_window_says_what_each_click_does(self):
        hint = self.hint({"id": SIDE["id"], "name": "Side"}, True)
        self.assertEqual(hint, "Side · lives in another window. Click to go there, shift+click to bring it here, "
                               "ctrl+shift+click to move it to a new window")

    def test_on_a_mac_a_space_in_another_window_says_cmd(self):
        hint = self.hint({"id": SIDE["id"], "name": "Side"}, True, windows=False)
        self.assertTrue(hint.endswith(", cmd+shift+click to move it to a new window"))


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
class ReturnFocus(unittest.TestCase):
    """Vivaldi re-focuses the address field of a tab that was left with the cursor in it, which floats the collapsed
    field open over the sidebar on a plain tab switch. Focus goes back to the page only when nobody asked for the field."""

    def give_back(self, **over):
        state = {"msSinceActivation": 20, "userAsked": False, "edited": False, "popupOpen": False, **over}
        return js("workspaces.returnFocus(state)", state=state)

    def test_a_focus_just_after_a_tab_switch_nobody_asked_for_goes_back_to_the_page(self):
        self.assertTrue(self.give_back())
        self.assertTrue(self.give_back(msSinceActivation=0))

    def test_the_window_closes_at_150_ms(self):
        self.assertTrue(self.give_back(msSinceActivation=150))
        self.assertFalse(self.give_back(msSinceActivation=151))
        self.assertFalse(self.give_back(msSinceActivation=5000))

    def test_a_focus_before_any_activation_or_with_no_timing_is_left_alone(self):
        self.assertFalse(self.give_back(msSinceActivation=-1))
        self.assertFalse(self.give_back(msSinceActivation=None))
        self.assertFalse(js("workspaces.returnFocus()"))

    def test_ctrl_l_f6_or_a_click_on_the_field_is_left_alone(self):
        self.assertFalse(self.give_back(userAsked=True))

    def test_typed_text_is_left_alone(self):
        self.assertFalse(self.give_back(edited=True))

    def test_a_permission_popup_in_the_field_is_left_alone(self):
        self.assertFalse(self.give_back(popupOpen=True))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class ShowsPage(unittest.TestCase):
    """The address field holds no edits when it shows the tab's own address, as Vivaldi writes it."""

    def shows(self, value, url, pending=None):
        return js("workspaces.showsPage(value, tab)", value=value, tab={"url": url, "pendingUrl": pending})

    def test_the_address_as_it_is(self):
        self.assertTrue(self.shows("https://example.com/a/b?q=1#x", "https://example.com/a/b?q=1#x"))
        self.assertTrue(self.shows("data:text/html,<title>Z</title>Z", "data:text/html,<title>Z</title>Z"))

    def test_vivaldi_drops_a_lone_trailing_slash_and_writes_internal_pages_with_one_colon(self):
        self.assertTrue(self.shows("https://example.com", "https://example.com/"))
        self.assertTrue(self.shows("vivaldi:settings", "vivaldi://settings/"))

    def test_a_page_still_loading_shows_its_pending_address(self):
        self.assertTrue(self.shows("https://example.com/next", "https://example.com/old", "https://example.com/next"))

    def test_anything_else_counts_as_typed(self):
        self.assertFalse(self.shows("exam", "https://example.com/"))
        self.assertFalse(self.shows("", "https://example.com/"))
        self.assertFalse(self.shows("https://example.com/other", "https://example.com/"))
        self.assertFalse(self.shows("https://example.com", None))

    def test_a_tab_that_cannot_be_read_counts_as_typed(self):
        self.assertFalse(js("workspaces.showsPage('x', null)"))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class BlankTab(unittest.TestCase):
    """Task 8q: Vivaldi's Start Page is a blank tab (the command bar opens over it) unless the user asked for it."""

    START = "chrome://vivaldi-webui/startpage"

    def blank(self, url=None, pending=None, ext=None, wanted="undefined"):
        tab = {"url": url, "pendingUrl": pending}
        if ext is not None:
            tab["vivExtData"] = ext
        return js(f"workspaces.isBlank(tab, {wanted})", tab=tab)

    def test_the_new_tab_and_start_page_addresses_are_blank(self):
        for url in ["chrome://newtab/", "vivaldi://newtab", self.START, self.START + "?section=Speed-dials",
                    self.START + "?section=Speed-dials&background-color=#363536"]:
            self.assertTrue(self.blank(url), url)

    def test_a_section_of_the_start_page_and_every_other_page_is_not(self):
        for section in ["Bookmarks", "History", "Notes", "Calendar", "Dashboard", "bookmarks"]:
            self.assertFalse(self.blank(self.START + "?section=" + section), section)
        for url in ["https://example.com/", "about:blank", "", None, "chrome://settings"]:
            self.assertFalse(self.blank(url), str(url))

    def test_the_pending_address_decides_while_a_tab_is_loading(self):
        self.assertTrue(self.blank("", self.START))
        self.assertFalse(self.blank(self.START, "https://example.com/"))

    def test_a_start_page_asked_for_is_not_blank(self):
        self.assertFalse(self.blank(self.START, ext='{"vmStart":true}'))
        self.assertFalse(self.blank(self.START, ext='{"workspaceId":3,"vmStart":true}'))
        self.assertFalse(self.blank(self.START, wanted="true"))
        self.assertFalse(self.blank("chrome://newtab/", ext='{"vmStart":true}'))

    def test_the_mark_is_ignored_unless_it_is_set_and_the_explicit_answer_wins(self):
        for ext in ['{}', '{"vmStart":false}', '{"vmStart":null}', "not json", None]:
            self.assertTrue(self.blank(self.START, ext=ext), str(ext))
        self.assertTrue(self.blank(self.START, ext='{"vmStart":true}', wanted="false"))
        self.assertFalse(self.blank(self.START, ext='{}', wanted="true"))

    def test_a_start_page_asked_for_is_called_Start_Page_not_by_its_address(self):
        title = lambda url, ext: js("workspaces.startTitle(tab)", tab={"url": url, "vivExtData": ext})
        self.assertEqual(title(self.START, '{"vmStart":true}'), "Start Page")
        for url, ext in [(self.START, "{}"), (self.START + "?section=Bookmarks", '{"vmStart":true}'), ("https://example.com/", '{"vmStart":true}')]:
            self.assertIsNone(title(url, ext), url)

    def test_the_mark_makes_no_page_blank(self):
        self.assertFalse(self.blank("https://example.com/", ext='{"vmStart":true}'))
        self.assertFalse(self.blank(self.START + "?section=Bookmarks", ext='{"vmStart":true}'))

    def test_a_typed_address_means_the_start_page_for_its_own_addresses_only(self):
        typed = lambda text: js("workspaces.startTyped(text)", text=text)
        for text in [self.START, self.START + "/", self.START + "?section=Speed-dials", "vivaldi://newtab", "chrome://newtab/",
                     "vivaldi://startpage", "  " + self.START + "  ", "CHROME://vivaldi-webui/startpage"]:
            self.assertTrue(typed(text), text)
        for text in [self.START + "?section=Bookmarks", "https://example.com/startpage", "vivaldi://settings", "startpage", "",
                     "https://vivaldi-webui/startpage", self.START + "x"]:
            self.assertFalse(typed(text), text)
        self.assertFalse(js("workspaces.startTyped(null)"))

    def test_the_mark_stays_inside_the_start_pages_family(self):
        family = lambda url: js("workspaces.inStartFamily(url)", url=url)
        for url in [self.START, self.START + "?section=Bookmarks", "chrome://newtab/"]:
            self.assertTrue(family(url), url)
        for url in ["https://example.com/", "", None, "about:blank"]:
            self.assertFalse(family(url), str(url))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the sidebar's JavaScript")
class SiteRequest(unittest.TestCase):
    """Vivaldi asks for a site's permission in a popup of its address field. Vivarc turns an undecided Allow/Deny question
    into a card; anything it cannot read whole (a decided panel, a device list, another popup) is not a request, so the
    field keeps floating for it."""

    NOTIF = "Website “http://127.0.0.1:1300/” would like to show notifications."

    def snap(self, **over):
        base = {"labelledBy": "popup-label-permissionprompt", "message": self.NOTIF, "undecided": True, "extras": 0,
                "buttons": [{"label": "Allow", "type": "submit", "disabled": False}, {"label": "Deny", "type": "button", "disabled": False}]}
        return {**base, **over}

    def read(self, **over):
        return js("workspaces.siteRequest(snap)", snap=self.snap(**over))

    def test_an_undecided_allow_deny_question_is_read_into_site_ask_and_options(self):
        got = self.read()
        self.assertEqual(got["site"], "http://127.0.0.1:1300")
        self.assertEqual(got["ask"], "would like to show notifications.")
        self.assertEqual([(o["label"], o["disabled"]) for o in got["options"]], [("Allow", False), ("Deny", False)])

    def test_the_options_keep_vivaldis_labels_order_and_disabled_state(self):
        got = self.read(buttons=[{"label": "Allow", "type": "submit", "disabled": True}, {"label": "Block", "type": "button", "disabled": False}])
        self.assertEqual([(o["label"], o["disabled"]) for o in got["options"]], [("Allow", True), ("Block", False)])

    def test_no_option_is_marked_as_the_one_a_key_answers(self):
        for option in self.read()["options"]:
            self.assertNotIn("primary", option)
            self.assertNotIn("default", option)

    def test_other_quote_styles_and_a_missing_quote_still_read(self):
        got = self.read(message="Website \"https://example.com\" would like to access your location.")
        self.assertEqual((got["site"], got["ask"]), ("https://example.com", "would like to access your location."))
        got = self.read(message="Seite «https://exemple.fr/» möchte Ihren Standort")
        self.assertEqual((got["site"], got["ask"]), ("https://exemple.fr", "möchte Ihren Standort"))
        got = self.read(message="Something unquoted wants a thing")
        self.assertEqual((got["site"], got["ask"]), ("", "Something unquoted wants a thing"))

    def test_the_site_is_text_not_markup(self):
        got = self.read(message="Website “<img src=x onerror=alert(1)>” would like to show notifications.")
        self.assertEqual(got["site"], "<img src=x onerror=alert(1)>")

    def test_anything_vivarc_cannot_read_whole_is_not_a_request(self):
        for over in [{"labelledBy": "popup-label-popupblocker"}, {"labelledBy": None}, {"undecided": False}, {"message": ""},
                     {"message": "   "}, {"extras": 1}, {"buttons": []}, {"buttons": None}, {"message": None},
                     {"buttons": [{"label": "", "type": "submit", "disabled": False}]},
                     {"buttons": [{"label": "OK", "type": "button", "disabled": False}, {"label": "Change", "type": "button", "disabled": False}], "undecided": False}]:
            self.assertIsNone(self.read(**over), over)
        self.assertIsNone(js("workspaces.siteRequest()"))
        self.assertIsNone(js("workspaces.siteRequest(null)"))

    def test_more_buttons_than_a_card_can_hold_is_not_a_request(self):
        many = [{"label": f"B{i}", "type": "button", "disabled": False} for i in range(5)]
        self.assertIsNone(self.read(buttons=many))
        self.assertEqual(len(self.read(buttons=many[:4])["options"]), 4)


if __name__ == "__main__":
    unittest.main()
