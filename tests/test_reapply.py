"""windows/reapply.py: the scheduled task's script, run against a fake Vivaldi install."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "windows"))
import module_state  # noqa: E402
import reapply  # noqa: E402
import vivarc  # noqa: E402
from peek_fixture import PEEK_CSS, PEEK_JS  # noqa: E402

STOCK = b"<html>\n<body>\n</body>\n</html>\n"
REAL_VIVALDI_RUNNING = reapply.vivaldi_running
REAL_TOAST = reapply.toast


@unittest.skipUnless(os.name == "nt", "the scheduled task and its paths are Windows-only")
class Reapply(unittest.TestCase):
    def setUp(self):
        module_state.restore_after(self, vivarc)  # reapply configures the module for Windows
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.app = self.tmp / "Vivaldi" / "Application"
        self.resources = self.app / "8.2.4133.96" / "resources" / "vivaldi"
        self.resources.mkdir(parents=True)
        (self.resources / "window.html").write_bytes(STOCK)  # what a Vivaldi update leaves
        self.data = self.tmp / "User Data"
        self.data.mkdir()
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.log_file = self.tmp / "log" / "reapply.log"
        self.toast = mock.Mock()
        self.running = mock.Mock(return_value=True)
        for p in (mock.patch.object(sys, "path", list(sys.path)),
                  mock.patch.object(reapply, "APP_DIR", str(ROOT)),
                  mock.patch.object(reapply, "LOG_DIR", str(self.log_file.parent)),
                  mock.patch.object(reapply, "LOG", str(self.log_file)),
                  mock.patch.object(reapply, "toast", self.toast),
                  mock.patch.object(reapply, "vivaldi_running", self.running),
                  mock.patch.object(vivarc, "HOME_DIR", str(self.home))):
            p.start()
            self.addCleanup(p.stop)

    def run_task(self, *extra):
        return reapply.main(["--app", str(self.app), "--data-dir", str(self.data), *extra])

    def html(self):
        return (self.resources / "window.html").read_bytes()

    def bundle(self):
        return (self.resources / "vivarc.js").read_text(encoding="utf8")

    def last_log(self):
        return self.log_file.read_text(encoding="utf8").splitlines()[-1]

    def test_puts_vivarc_back_after_an_update_and_says_to_restart(self):
        self.assertEqual(self.run_task(), 0)
        self.assertIn(vivarc.BEGIN.encode(), self.html())
        self.assertNotIn(b"\r", self.html())
        self.assertTrue((self.resources / "vivarc.js").is_file())
        self.assertIn("re-applied Vivarc to Vivaldi 8.2.4133.96; Vivaldi is running, restart needed", self.last_log())
        self.toast.assert_called_once()
        self.assertEqual(self.toast.call_args.args[0], "Revival Arc re-applied")
        self.assertIn("Restart Vivaldi", self.toast.call_args.args[1])

    def test_writes_nothing_into_the_users_profile(self):
        # Elevated writes into a user-writable folder can be redirected with a junction: the task must not make any.
        self.run_task()
        self.assertEqual(list(self.home.iterdir()), [])

    def plant_peek(self):
        peek = self.home / "peek"
        peek.mkdir()
        (peek / "VividPeek.js").write_text(PEEK_JS, encoding="utf8")
        (peek / "VividPeek.css").write_text(PEEK_CSS, encoding="utf8")

    def test_puts_a_downloaded_peek_back_set_to_open_on_shift_click_only(self):
        self.plant_peek()
        self.run_task()
        bundle = self.bundle()
        self.assertIn("PEEK-SENTINEL", bundle)
        self.assertIn('clickOpenModifiers: ["shift"],', bundle)
        self.assertIn("autoOpenList: [],", bundle)

    def test_logs_why_a_downloaded_peek_was_left_out(self):
        self.plant_peek()
        (self.home / "peek" / "VividPeek.js").write_text("/* PEEK-SENTINEL */ const ICON_CONFIG = {};", encoding="utf8")
        self.assertEqual(self.run_task(), 0)
        self.assertNotIn("PEEK-SENTINEL", self.bundle())
        self.assertIn("Peek left out", self.log_file.read_text(encoding="utf8"))

    def test_leaves_a_downloaded_peek_out_when_the_config_turns_it_off(self):
        self.plant_peek()
        (self.home / "config.json").write_text('{"peek": false}', encoding="utf8")
        self.run_task()
        self.assertNotIn("PEEK-SENTINEL", self.bundle())
        self.assertNotIn("peek-sentinel", self.bundle())

    def test_does_nothing_when_vivarc_is_already_in_place(self):
        self.run_task()
        applied = self.html()
        self.toast.reset_mock()
        self.assertEqual(self.run_task(), 0)
        self.assertEqual(self.html(), applied)
        self.assertIn("already has Vivarc; nothing to do", self.last_log())
        self.toast.assert_not_called()

    def test_force_refreshes_vivarc_that_is_already_in_place(self):
        self.run_task()
        (self.resources / "vivarc.js").write_text("/* STALE-BUNDLE-SENTINEL */")
        self.assertEqual(self.run_task("--force", "--no-toast"), 0)
        self.assertNotIn("STALE-BUNDLE-SENTINEL", self.bundle())
        self.assertEqual(self.html().count(vivarc.BEGIN.encode()), 1)
        self.assertIn("force-re-applied", self.last_log())
        self.toast.assert_called_once()  # only the first run's

    def test_tells_the_user_it_is_back_when_vivaldi_is_closed(self):
        self.running.return_value = False
        self.run_task()
        self.assertIn("Vivarc is back on Vivaldi 8.2.4133.96", self.toast.call_args.args[1])
        self.assertNotIn("restart", self.last_log())

    def test_no_vivaldi_is_logged_and_left_alone(self):
        (self.resources / "window.html").unlink()
        self.assertEqual(self.run_task(), 0)
        self.assertIn("no Vivaldi window.html", self.last_log())
        self.assertFalse((self.resources / "vivarc.js").exists())

    def test_a_failure_is_logged_and_shown_and_leaves_vivaldi_alone(self):
        with mock.patch.object(vivarc, "can_write", return_value=False):
            self.assertEqual(self.run_task(), 1)
        self.assertEqual(self.html(), STOCK)
        log = self.log_file.read_text(encoding="utf8")
        self.assertIn("FAILED", log)
        self.assertIn("Cannot write", log)
        self.assertEqual(self.toast.call_args.args[0], "Revival Arc: re-apply failed")

    def test_bad_arguments_are_logged_not_lost(self):
        self.assertEqual(reapply.main(["--bogus", "--no-toast"]), 2)
        self.assertIn("FAILED", self.log_file.read_text(encoding="utf8"))
        self.toast.assert_not_called()

    def test_a_broken_toast_does_not_fail_the_run(self):
        with mock.patch.object(reapply, "toast", REAL_TOAST), \
             mock.patch.object(reapply.subprocess, "run", side_effect=OSError("no powershell")):
            self.assertEqual(self.run_task(), 0)
        log = self.log_file.read_text(encoding="utf8")
        self.assertIn("re-applied", log)
        self.assertIn("toast failed: no powershell", log)

    def test_a_toast_that_exits_with_an_error_is_logged(self):
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="WinRT says no")
        with mock.patch.object(reapply, "toast", REAL_TOAST), mock.patch.object(reapply.subprocess, "run", return_value=failed):
            self.run_task()
        self.assertIn("toast failed (exit 1): WinRT says no", self.log_file.read_text(encoding="utf8"))

    def test_running_check_assumes_running_when_it_cannot_tell(self):
        with mock.patch.object(reapply.subprocess, "run", side_effect=OSError("no tasklist")):
            self.assertTrue(REAL_VIVALDI_RUNNING())

    def test_refuses_to_log_through_a_junction(self):
        target = self.tmp / "elsewhere"
        target.mkdir()
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(self.log_file.parent), str(target)], capture_output=True)
        if made.returncode:
            self.skipTest("cannot create a junction here")
        self.assertEqual(self.run_task(), 0)  # the run itself still succeeds
        self.assertEqual(list(target.iterdir()), [])
        self.assertIn(vivarc.BEGIN.encode(), self.html())


@unittest.skipUnless(os.name == "nt", "Windows paths")
class Paths(unittest.TestCase):
    def test_paths_come_from_the_os_not_the_environment(self):
        with mock.patch.dict(os.environ, {"ProgramData": r"C:\Users\Public\evil", "SystemRoot": r"C:\Users\Public\evil"}):
            self.assertNotIn("evil", reapply._program_data())
            self.assertNotIn("evil", reapply._system_dir())
        self.assertTrue(os.path.isfile(reapply.POWERSHELL))
        self.assertTrue(os.path.isfile(reapply.TASKLIST))


if __name__ == "__main__":
    unittest.main()
