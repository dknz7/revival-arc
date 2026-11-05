import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import vivarc  # noqa: E402
import module_state  # noqa: E402
from peek_fixture import PEEK_CSS, PEEK_JS  # noqa: E402

REAL_DEFS = os.path.join(vivarc.DEFAULT_APP, vivarc.RESOURCES, "prefs_definitions.json")
FAKE_DEFS = {"vivaldi": {"actions": {"default_mac": [{
    "COMMAND_NEW_TAB": {"shortcuts": ["meta+t"]},
    "COMMAND_SHOW_QUICK_COMMANDS": {"shortcuts": ["meta+t", "meta+e", "f2"]},
    "COMMAND_PAGE_COPY_URL": {"shortcuts": ["meta+c"]},
}], "default": [{}], "default_linux": [{}]}}}


class InstallFlow(unittest.TestCase):
    """Runs install and uninstall against a fake Vivaldi app and data folder (a fresh-profile simulation)."""

    def setUp(self):
        module_state.restore_after(self, vivarc)  # main() reconfigures the module on a Windows host
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.app = os.path.join(self.tmp, "Vivaldi.app")
        res = os.path.join(self.app, vivarc.RESOURCES)
        os.makedirs(res)
        with open(os.path.join(res, "prefs_definitions.json"), "w") as f:
            json.dump(FAKE_DEFS, f)
        with open(os.path.join(res, "window.html"), "w") as f:
            f.write("<html><body>\n</body></html>\n")
        self.data = os.path.join(self.tmp, "data")
        for name in ("Default", "Profile 1"):
            os.makedirs(os.path.join(self.data, name))
            with open(os.path.join(self.data, name, "Preferences"), "w") as f:
                json.dump({"vivaldi": {"toolbars": {"tabbar_before": ["TabButton", "Spacer"]}}}, f)
        with open(os.path.join(self.data, "Local State"), "w") as f:
            json.dump({"profile": {"info_cache": {"Default": {"name": "Me"}, "Profile 1": {"name": "Work"}}}}, f)
        self.home = os.path.join(self.tmp, "home")
        patches = [
            mock.patch.object(vivarc, "HOME_DIR", self.home),
            mock.patch.object(vivarc, "REMINDER_PLIST", os.path.join(self.tmp, "LaunchAgents", "reminder.plist")),
            mock.patch.object(vivarc, "launchctl"),
            mock.patch.object(vivarc, "UPDATE_COMMAND", os.path.join(self.tmp, "home", "Update Vivarc.command")),
            mock.patch.object(vivarc, "UPDATE_APP", os.path.join(self.tmp, "Applications", "Update Vivarc.app")),
            mock.patch.object(vivarc, "LEGACY_UPDATE_COMMAND", os.path.join(self.tmp, "Applications", "Update Vivarc.command")),
            mock.patch.object(vivarc, "UNINSTALL_COMMAND", os.path.join(self.tmp, "home", "Uninstall Vivarc.command")),
            mock.patch.object(vivarc, "UNINSTALL_APP", os.path.join(self.tmp, "Applications", "Uninstall Vivarc.app")),
            # Never the real ones: install and uninstall remove these (the launchers an earlier install left elsewhere).
            mock.patch.object(vivarc, "LEGACY_APPS", [os.path.join(self.tmp, "OtherApplications", name)
                                                      for name in ("Update Vivarc.app", "Uninstall Vivarc.app")]),
            mock.patch.object(vivarc, "vivaldi_running", return_value=False),
            mock.patch.object(vivarc, "app_version", return_value="9.9.9"),
            mock.patch.object(vivarc, "ask", return_value=None),
            # Never the real ones: they open System Settings and quit the user's Vivaldi.
            mock.patch.object(vivarc, "open_settings"),
            mock.patch.object(vivarc, "quit_vivaldi"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_cli(self, *args):
        vivarc.main(["--app", self.app, "--data-dir", self.data, *args])

    def prefs(self, name):
        with open(os.path.join(self.data, name, "Preferences")) as f:
            return json.load(f)

    def test_install_configures_every_profile_and_injects_the_js(self):
        self.run_cli("install", "--no-peek")
        for name in ("Default", "Profile 1"):
            vivaldi = self.prefs(name)["vivaldi"]
            self.assertEqual(vivaldi["toolbars"]["tabbar_before"][-1], "AddressField")
            self.assertNotIn("Spacer", vivaldi["toolbars"]["tabbar_before"])
            self.assertNotIn("appearance", vivaldi)
            self.assertEqual(vivaldi["actions"][0]["COMMAND_NEW_TAB"]["shortcuts"], [])
        res = os.path.join(self.app, vivarc.RESOURCES)
        with open(os.path.join(res, "window.html")) as f:
            self.assertIn("vivarc.js", f.read())
        with open(os.path.join(res, "vivarc.js")) as f:
            bundle = f.read()
        self.assertIn("[vivarc] core started", bundle)
        self.assertFalse(os.path.exists(os.path.join(self.home, "css")))

    def write_config(self, config):
        os.makedirs(self.home, exist_ok=True)
        with open(os.path.join(self.home, "config.json"), "w") as f:
            json.dump(config, f)

    def plant_peek(self):
        peek = os.path.join(self.home, "peek")
        os.makedirs(peek, exist_ok=True)
        with open(os.path.join(peek, "VividPeek.js"), "w", encoding="utf8") as f:
            f.write(PEEK_JS)
        with open(os.path.join(peek, "VividPeek.css"), "w", encoding="utf8") as f:
            f.write(PEEK_CSS)

    def bundle(self):
        with open(os.path.join(self.app, vivarc.RESOURCES, "vivarc.js")) as f:
            return f.read()

    def test_install_downloads_peek_by_default(self):
        with mock.patch.object(vivarc, "fetch_peek", side_effect=self.plant_peek) as fetch:
            self.run_cli("install")
        fetch.assert_called_once()
        self.assertIn("PEEK-SENTINEL", self.bundle())

    def test_peek_false_in_the_config_keeps_install_from_downloading_or_bundling_it(self):
        self.write_config({"peek": False})
        with mock.patch.object(vivarc, "fetch_peek", side_effect=self.plant_peek) as fetch:
            self.run_cli("install")  # no --no-peek: the "Update Vivarc" launcher passes none
        fetch.assert_not_called()
        self.assertNotIn("PEEK-SENTINEL", self.bundle())

    def test_apply_bundles_a_downloaded_peek_by_default(self):
        self.plant_peek()
        self.run_cli("apply")
        self.assertIn("PEEK-SENTINEL", self.bundle())

    def test_peek_false_in_the_config_keeps_apply_from_bundling_a_downloaded_peek(self):
        self.plant_peek()
        self.write_config({"peek": False})
        self.run_cli("apply")
        bundle = self.bundle()
        self.assertNotIn("PEEK-SENTINEL", bundle)
        self.assertNotIn("peek-sentinel", bundle)

    def test_running_install_twice_keeps_the_original_snapshot(self):
        self.run_cli("install", "--no-peek")
        self.run_cli("install", "--no-peek")
        self.run_cli("uninstall")
        self.assertEqual(self.prefs("Default")["vivaldi"]["toolbars"]["tabbar_before"], ["TabButton", "Spacer"])

    def test_uninstall_restores_prefs_flags_and_window_html(self):
        before = self.prefs("Default")
        self.run_cli("install", "--no-peek")
        self.run_cli("uninstall")
        self.assertEqual(self.prefs("Default"), before)
        res = os.path.join(self.app, vivarc.RESOURCES)
        with open(os.path.join(res, "window.html")) as f:
            self.assertNotIn("vivarc", f.read())
        self.assertFalse(os.path.exists(os.path.join(res, "vivarc.js")))

    def test_the_stylesheet_travels_inside_the_bundle(self):
        self.run_cli("install", "--no-peek")
        res = os.path.join(self.app, vivarc.RESOURCES)
        with open(os.path.join(res, "vivarc.js")) as f:
            bundle = f.read()
        with open(os.path.join(vivarc.HERE, "src", "css", "vivarc.css")) as f:
            self.assertIn(json.dumps(f.read()), bundle)

    def test_install_puts_the_guide_page_in_place_and_tells_the_js_its_url(self):
        self.run_cli("install", "--no-peek")
        page = os.path.join(self.home, "start", "index.html")
        self.assertTrue(os.path.exists(page))
        res = os.path.join(self.app, vivarc.RESOURCES)
        with open(os.path.join(res, "vivarc.js")) as f:
            self.assertIn(json.dumps(pathlib.Path(page).as_uri()), f.read())

    def test_uninstall_also_cleans_profiles_the_js_configured_on_its_own(self):
        self.run_cli("install", "--no-peek")
        # a profile created later and configured at runtime: Vivarc's keys, no snapshot
        os.makedirs(os.path.join(self.data, "Profile 2"))
        configured, _ = vivarc.patch_preferences({}, [FAKE_DEFS["vivaldi"]["actions"]["default_mac"][0]])
        with open(os.path.join(self.data, "Profile 2", "Preferences"), "w") as f:
            json.dump(configured, f)
        with open(os.path.join(self.data, "Local State"), "w") as f:
            json.dump({"profile": {"info_cache": {"Default": {}, "Profile 1": {}, "Profile 2": {}}}}, f)
        self.run_cli("uninstall")
        self.assertEqual(self.prefs("Profile 2"), {})

    def test_uninstall_leaves_an_unconfigured_profile_alone(self):
        self.run_cli("install", "--no-peek")
        os.makedirs(os.path.join(self.data, "Profile 2"))
        plain = {"vivaldi": {"tabs": {"bar": {"position": 0}}}}
        with open(os.path.join(self.data, "Profile 2", "Preferences"), "w") as f:
            json.dump(plain, f)
        with open(os.path.join(self.data, "Local State"), "w") as f:
            json.dump({"profile": {"info_cache": {"Default": {}, "Profile 1": {}, "Profile 2": {}}}}, f)
        self.run_cli("uninstall")
        self.assertEqual(self.prefs("Profile 2"), plain)

    def test_apply_alone_also_puts_the_guide_page_in_place(self):
        self.run_cli("apply")
        self.assertTrue(os.path.exists(os.path.join(self.home, "start", "index.html")))

    def test_install_changes_nothing_when_macos_refuses_write_access(self):
        before = self.prefs("Default")
        with mock.patch.object(vivarc, "can_write", return_value=False):
            with self.assertRaises(SystemExit):
                self.run_cli("install", "--no-peek")
        if not vivarc.IS_WINDOWS:  # Windows has its own preflight, with no Settings to open
            vivarc.open_settings.assert_called_once()  # the stub from setUp, not System Settings
        self.assertEqual(self.prefs("Default"), before)
        self.assertFalse(os.path.exists(os.path.join(self.home, "state.json")))
        self.assertFalse(os.path.exists(os.path.join(self.home, "peek")))

    def test_apply_works_while_vivaldi_is_open_and_says_to_restart(self):
        with mock.patch.object(vivarc, "vivaldi_running", return_value=True):
            self.run_cli("apply")
        res = os.path.join(self.app, vivarc.RESOURCES)
        self.assertTrue(os.path.exists(os.path.join(res, "vivarc.js")))

    def test_apply_overwrites_a_read_only_bundle_left_by_an_earlier_run(self):
        self.run_cli("install", "--no-peek")
        bundle = os.path.join(self.app, vivarc.RESOURCES, "vivarc.js")
        os.chmod(bundle, 0o444)
        self.run_cli("apply")
        with open(bundle) as f:
            self.assertIn("[vivarc] core started", f.read())

    def test_install_leaves_a_double_clickable_update_script_and_uninstall_removes_it(self):
        self.run_cli("install", "--no-peek")
        self.assertTrue(os.path.exists(vivarc.UPDATE_COMMAND))
        self.run_cli("uninstall")
        self.assertFalse(os.path.exists(vivarc.UPDATE_COMMAND))

    def test_install_leaves_a_dockable_app_and_uninstall_removes_it(self):
        self.run_cli("install", "--no-peek")
        self.assertTrue(os.path.exists(os.path.join(vivarc.UPDATE_APP, "Contents", "Info.plist")))
        self.run_cli("uninstall")
        self.assertFalse(os.path.exists(vivarc.UPDATE_APP))

    def test_install_leaves_an_uninstall_app_that_runs_uninstall_and_uninstall_removes_it(self):
        self.run_cli("install", "--no-peek")
        self.assertTrue(os.path.exists(os.path.join(vivarc.UNINSTALL_APP, "Contents", "Info.plist")))
        with open(vivarc.UNINSTALL_COMMAND) as f:
            script = f.read()
        self.assertIn("vivarc.py", script)
        self.assertIn(" uninstall\n", script)
        self.assertTrue(os.access(vivarc.UNINSTALL_COMMAND, os.X_OK))
        self.run_cli("uninstall")
        self.assertFalse(os.path.exists(vivarc.UNINSTALL_APP))
        self.assertFalse(os.path.exists(vivarc.UNINSTALL_COMMAND))

    def test_install_removes_the_script_that_older_versions_left_in_the_applications_folder(self):
        vivarc.write_update_command(vivarc.LEGACY_UPDATE_COMMAND)
        self.run_cli("install", "--no-peek")
        self.assertFalse(os.path.exists(vivarc.LEGACY_UPDATE_COMMAND))

    def test_install_moves_the_launchers_out_of_the_other_applications_folder_and_leaves_other_apps_alone(self):
        old_update, old_uninstall = vivarc.LEGACY_APPS
        vivarc.write_update_app(old_update, vivarc.UPDATE_COMMAND)   # an earlier install's, in the other folder
        os.makedirs(os.path.join(old_uninstall, "Contents"))          # not Vivarc's: same name, no Vivarc mark
        self.run_cli("install", "--no-peek")
        self.assertTrue(os.path.exists(os.path.join(vivarc.UPDATE_APP, "Contents", "Info.plist")))
        self.assertFalse(os.path.exists(old_update))
        self.assertTrue(os.path.exists(old_uninstall))
        vivarc.write_update_app(old_update, vivarc.UPDATE_COMMAND)
        self.run_cli("uninstall")
        self.assertFalse(os.path.exists(old_update))

    def test_install_only_turns_the_reminder_on_when_the_user_says_yes(self):
        self.run_cli("install", "--no-peek")
        self.assertFalse(os.path.exists(vivarc.REMINDER_PLIST))
        with mock.patch.object(vivarc, "ask", return_value="y"):
            self.run_cli("install", "--no-peek")
        self.assertTrue(os.path.exists(vivarc.REMINDER_PLIST))
        self.run_cli("uninstall")
        self.assertFalse(os.path.exists(vivarc.REMINDER_PLIST))

    def test_refuses_to_run_while_vivaldi_is_open(self):
        with mock.patch.object(vivarc, "vivaldi_running", return_value=True):
            with self.assertRaises(SystemExit):
                self.run_cli("install", "--no-peek")


class PromptsAreReplaceable(unittest.TestCase):
    """The install checks look up their prompt, quit and Settings helpers when called. Bound as defaults instead, they
    ignored the tests' patches: on a Mac with a terminal, the suite asked the user, quit their Vivaldi and opened
    System Settings."""

    def test_the_vivaldi_check_uses_the_current_ask_and_quit(self):
        asked = []
        with mock.patch.object(vivarc, "vivaldi_running", return_value=True), \
                mock.patch.object(vivarc, "ask", side_effect=lambda prompt: asked.append(prompt) or "y"), \
                mock.patch.object(vivarc, "quit_vivaldi") as quit_app:
            with self.assertRaises(SystemExit):  # the mock never closes, so it says Vivaldi did not close
                vivarc.ensure_vivaldi_closed()
        self.assertEqual(len(asked), 1)
        quit_app.assert_called_once()

    def test_the_permission_check_uses_the_current_ask_and_settings(self):
        asked = []
        with mock.patch.object(vivarc, "can_write", return_value=False), \
                mock.patch.object(vivarc, "ask", side_effect=lambda prompt: asked.append(prompt) or "q"), \
                mock.patch.object(vivarc, "open_settings") as open_settings:
            with self.assertRaises(SystemExit):
                vivarc.preflight("/nowhere")
        self.assertEqual(len(asked), 1)
        open_settings.assert_called_once()


if __name__ == "__main__":
    unittest.main()
