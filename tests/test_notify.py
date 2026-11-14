import shutil
import unittest

from jsrun import run_js


def js(expr, **data):
    return run_js("17-notify.js", f"(() => {{ const n = window.__vm.notifyLogic; return {expr}; }})()", **data)


def note(id, type="message", tab=None, at=0):
    return {"id": id, "type": type, "tab": tab, "at": at}


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class Surfaces(unittest.TestCase):
    """Task 9b: where each kind of notification goes, with the command bar closed and open (Byron's decisions)."""

    def surface(self, type, bar):
        return js("n.surfaceOf(type, bar)", type=type, bar=bar)

    def test_a_question_is_a_toast_with_the_bar_closed_and_a_fly_up_row_with_it_open(self):
        for type in ["permission", "pending"]:
            self.assertEqual((self.surface(type, False), self.surface(type, True)), ("toast", "fly"), type)

    def test_indicators_and_page_actions_never_pop_up(self):
        for type in ["decided", "security", "translate", "siteInfo", "reader", "feeds", "install", "qr"]:
            self.assertEqual((self.surface(type, False), self.surface(type, True)), ("none", "row"), type)

    def test_the_users_own_actions_and_vivarcs_messages_are_short_toasts(self):
        for type in ["popupBlocked", "zoom", "bookmarked", "message"]:
            self.assertEqual((self.surface(type, False), self.surface(type, True)), ("toast", "fly"), type)

    def test_vivaldis_own_ui_stays_vivaldis(self):
        for type in ["device", "download", "find", "dialog", "fullscreen", "cast", "extension"]:
            self.assertEqual((self.surface(type, False), self.surface(type, True)), ("vivaldi", "vivaldi"), type)

    def test_the_password_bubble_and_anything_unknown_get_nothing(self):
        self.assertEqual(self.surface("password", False), "none")
        self.assertEqual(self.surface("nonsense", True), "none")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class Ownership(unittest.TestCase):
    """Notifications belong to their tab: only the active tab's (and Vivarc's own, with no tab) show."""

    NOTES = [note("a", "permission", tab=1, at=5), note("b", "zoom", tab=2, at=1), note("c", "message", tab=None, at=3),
             note("d", "decided", tab=1, at=0), note("e", "popupBlocked", tab=1, at=2)]

    def ids(self, expr, **data):
        return [x["id"] for x in js(expr, notes=self.NOTES, **data)]

    def test_another_tabs_notifications_hide_and_vivarcs_own_stay(self):
        self.assertEqual(self.ids("n.toastsFor(notes, 1, false)"), ["a", "e", "c"])
        self.assertEqual(self.ids("n.toastsFor(notes, 2, false)"), ["b", "c"])

    def test_coming_back_to_the_tab_brings_them_back(self):
        self.assertEqual(self.ids("n.toastsFor(notes, 1, false)"), self.ids("(n.toastsFor(notes, 2, false), n.toastsFor(notes, 1, false))"))

    def test_nothing_is_a_toast_while_the_bar_is_open_it_is_in_the_fly_up(self):
        self.assertEqual(self.ids("n.toastsFor(notes, 1, true)"), [])
        self.assertEqual(self.ids("n.flyFor(notes, 1)"), ["a", "e", "c"])

    def test_indicators_are_never_toasts(self):
        self.assertNotIn("d", self.ids("n.toastsFor(notes, 1, false)"))
        self.assertNotIn("d", self.ids("n.flyFor(notes, 1)"))  # rows are built by the fly-up from the page's state

    def test_questions_come_first_then_the_rest_oldest_first(self):
        notes = [note("m1", "message", at=1), note("q2", "permission", tab=1, at=9), note("z", "zoom", tab=1, at=4), note("q1", "pending", tab=1, at=7)]
        self.assertEqual([x["id"] for x in js("n.ordered(notes)", notes=notes)], ["q1", "q2", "m1", "z"])


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class Stacking(unittest.TestCase):
    """Up to three notifications show as three rows; a fourth folds them into one stack that opens on a click."""

    def plan(self, count, expanded=False):
        return js("n.stackPlan(count, expanded)", count=count, expanded=expanded)

    def test_up_to_three_are_rows(self):
        for count in range(4):
            self.assertEqual(self.plan(count)["mode"], "rows", count)
            self.assertEqual(self.plan(count)["shown"], count)

    def test_a_fourth_folds_them_into_one_stack(self):
        got = self.plan(4)
        self.assertEqual((got["mode"], got["shown"], got["hidden"]), ("stack", 1, 3))
        self.assertEqual(self.plan(9)["hidden"], 8)

    def test_an_opened_stack_shows_them_all(self):
        got = self.plan(5, True)
        self.assertEqual((got["mode"], got["shown"]), ("open", 5))

    def test_opening_means_nothing_below_four(self):
        self.assertEqual(self.plan(3, True)["mode"], "rows")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class Buttons(unittest.TestCase):
    def fit(self, labels, message=""):
        return js("n.buttonsFit(labels, message)", labels=labels, message=message)

    def test_two_short_buttons_go_on_the_right(self):
        self.assertTrue(self.fit(["Allow", "Deny"], "127.0.0.1 would like to show notifications."))
        self.assertTrue(self.fit(["Reset"], "Zoom 110%"))
        self.assertTrue(self.fit([]))

    def test_three_buttons_or_long_labels_or_a_long_message_go_under_it(self):
        self.assertFalse(self.fit(["Allow", "Deny", "Later"]))
        self.assertFalse(self.fit(["Always allow", "Never allow"]))
        self.assertFalse(self.fit(["Allow", "Deny"], "x" * 71))


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class Jargon(unittest.TestCase):
    """Vivaldi shows some questions as its raw permission name with no site (measured on 8.3, task 8x)."""

    def plain(self, ask, url="https://maps.example/x", site="", prefix=""):
        return js("n.plainRequest(r, url)", r={"prefix": prefix, "site": site, "ask": ask, "options": []}, url=url)

    def test_window_placement_and_local_fonts_become_sentences_with_the_tabs_site(self):
        got = self.plain("window-placement")
        self.assertEqual((got["site"], got["ask"], got["raw"]), ("https://maps.example", "wants to see your screens, to place its windows on them.", "window-placement"))
        got = self.plain("local-fonts", url="http://127.0.0.1:4000/page")
        self.assertEqual((got["site"], got["ask"]), ("http://127.0.0.1:4000", "wants to use the fonts installed on this computer."))

    def test_an_unknown_raw_name_still_reads_as_words(self):
        self.assertEqual(self.plain("some-new_thing")["ask"], "wants to use some new thing.")

    def test_a_page_without_a_web_address_is_this_site(self):
        self.assertEqual(self.plain("local-fonts", url="chrome://settings")["site"], "This site")

    def test_vivaldis_own_sentences_are_left_as_they_are(self):
        r = {"prefix": "Website", "site": "http://a.example", "ask": "would like to show notifications.", "options": []}
        self.assertEqual(js("n.plainRequest(r, 'https://b.example')", r=r), r)
        self.assertEqual(self.plain("Something unquoted wants a thing")["ask"], "Something unquoted wants a thing")


@unittest.skipUnless(shutil.which("node"), "node is needed to test the notifications' JavaScript")
class DropPoint(unittest.TestCase):
    """Toasts drop from under the Dia breadcrumb (its left edge) or the Arc layout's URL bar, else the sidebar or page."""

    def rect(self, l, t, w, h):
        return {"left": l, "top": t, "right": l + w, "bottom": t + h, "width": w, "height": h}

    def drop(self, **r):
        return js("n.dropPoint(r)", r={"winW": 1400, **r})

    def test_dia_drops_from_the_crumbs_left_edge_just_below_it(self):
        got = self.drop(crumb=self.rect(540, 8, 300, 30), url=self.rect(8, 50, 300, 36), panel=self.rect(0, 0, 323, 700), page=self.rect(323, 46, 1070, 650))
        self.assertEqual((got["x"], got["y"]), (540, 44))

    def test_arc_drops_from_the_url_bar_at_its_width(self):
        got = self.drop(url=self.rect(8, 50, 307, 36), panel=self.rect(0, 0, 323, 700))
        self.assertEqual((got["x"], got["y"], got["w"]), (8, 92, 307))

    def test_without_them_the_sidebar_then_the_page(self):
        self.assertEqual(self.drop(panel=self.rect(0, 6, 323, 700))["y"], 14)
        got = self.drop(page=self.rect(0, 0, 1400, 760))
        self.assertEqual((got["x"], got["y"]), (12, 12))

    def test_it_stays_inside_the_window(self):
        got = self.drop(crumb=self.rect(1300, 8, 90, 30))
        self.assertEqual(got["x"], 1400 - 360 - 8)


if __name__ == "__main__":
    unittest.main()
