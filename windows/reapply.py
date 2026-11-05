"""Revival Arc: put Vivarc back after a Vivaldi update.

Run by the RevivalArc-Reapply scheduled task (elevated, see deploy.ps1) from C:\\Program Files\\RevivalArc, with the
embedded Python in isolated mode. A Vivaldi update replaces the version folder, which drops vivarc.js and the block in
window.html; this script checks the newest version folder and, only when Vivarc is missing (or with --force), writes
the bundle and the window.html block again. Peek goes back in when the install downloaded it and config.json does not
turn it off; it only reads ~/.vivarc/peek, as it already reads config.json and icons.js, and downloads nothing.

The task runs elevated, so this script writes ONLY into Vivaldi's install folder and its own log folder, never into
the user's profile (a user-writable folder could be swapped for a junction that redirects an elevated write). That is
why it does not call vivarc's apply_js()/sync_guide(): those also back up window.html and copy the guide into
~/.vivarc, which the unelevated install has already done. Paths come from the OS, not from environment variables the
user can set.

Every run is logged to <ProgramData>\\RevivalArc\\reapply.log; a re-apply or a failure also shows a Windows toast.
"""
import argparse
import contextlib
import csv
import ctypes
import datetime
import io
import os
import subprocess
import sys
import traceback
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(HERE, "app")
DEFAULT_APP = r"C:\Program Files\Vivaldi\Application"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
REPARSE_POINT = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT: junctions and symlinks


def _system_dir():
    buf = ctypes.create_unicode_buffer(260)
    if ctypes.windll.kernel32.GetSystemDirectoryW(buf, len(buf)):
        return buf.value
    return r"C:\Windows\System32"


def _program_data():
    """FOLDERID_ProgramData from the shell (machine registry), not %ProgramData%, which a user can override."""
    class GUID(ctypes.Structure):
        _fields_ = [("data", ctypes.c_ubyte * 16)]
    folder = GUID()
    ctypes.memmove(folder.data, uuid.UUID("62AB5D82-FDC1-4DC3-A9DD-070D1D495D97").bytes_le, 16)
    path = ctypes.c_wchar_p()
    try:
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(folder), 0, None, ctypes.byref(path)) == 0:
            return path.value
    finally:
        ctypes.windll.ole32.CoTaskMemFree(path)
    return r"C:\ProgramData"


SYSTEM32 = _system_dir() if os.name == "nt" else "/nonexistent"
WINDIR = os.path.dirname(SYSTEM32)
LOG_DIR = os.path.join(_program_data() if os.name == "nt" else "/nonexistent", "RevivalArc")
LOG = os.path.join(LOG_DIR, "reapply.log")
MAX_LOG_BYTES = 512 * 1024
POWERSHELL = os.path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe")
TASKLIST = os.path.join(SYSTEM32, "tasklist.exe")
# Windows PowerShell's registered app id, so the toast needs no app registration of its own.
TOAST_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
TOAST_SCRIPT = (
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
    "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
    "$t = $x.GetElementsByTagName('text');"
    "$t.Item(0).AppendChild($x.CreateTextNode($env:REVIVAL_ARC_TITLE)) > $null;"
    "$t.Item(1).AppendChild($x.CreateTextNode($env:REVIVAL_ARC_BODY)) > $null;"
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:REVIVAL_ARC_APP_ID)"
    ".Show([Windows.UI.Notifications.ToastNotification]::new($x))"
)


def _is_reparse_point(path):
    try:
        return bool(os.lstat(path).st_file_attributes & REPARSE_POINT)
    except (FileNotFoundError, AttributeError):
        return False


def log(message):
    if _is_reparse_point(LOG_DIR) or _is_reparse_point(LOG):
        raise RuntimeError(f"{LOG_DIR} or its log is a junction or symlink; not writing to it")
    os.makedirs(LOG_DIR, exist_ok=True)
    if os.path.exists(LOG) and os.path.getsize(LOG) > MAX_LOG_BYTES:
        os.replace(LOG, LOG + ".1")
    with open(LOG, "a", encoding="utf8") as f:
        f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {message}\n")


def safe_log(message):
    """Logging must never be what breaks a run."""
    try:
        log(message)
    except Exception:
        pass


def toast(title, body):
    # A minimal, fixed environment: nothing the user set (PSModulePath above all) reaches the elevated PowerShell.
    # The text goes in through the environment, never into the script, so nothing in it is parsed as code.
    env = {"SystemRoot": WINDIR, "windir": WINDIR, "SystemDrive": WINDIR[:2],
           "TEMP": os.path.join(WINDIR, "Temp"), "TMP": os.path.join(WINDIR, "Temp"),
           "PSModulePath": os.path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "Modules"),
           "REVIVAL_ARC_TITLE": title, "REVIVAL_ARC_BODY": body, "REVIVAL_ARC_APP_ID": TOAST_APP_ID}
    try:
        result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT],
                                env=env, capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW)
        if result.returncode:
            safe_log(f"toast failed (exit {result.returncode}): {(result.stderr or '').strip()[-300:]}")
    except Exception as error:  # a missing toast must never fail the run
        safe_log(f"toast failed: {error}")


def vivaldi_running():
    """True when vivaldi.exe is running, or when that cannot be told (then the toast still says to restart)."""
    try:
        out = subprocess.run([TASKLIST, "/FI", "IMAGENAME eq vivaldi.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW).stdout
        return any(row and row[0].lower() == "vivaldi.exe" for row in csv.reader(io.StringIO(out)))
    except Exception:
        return True


def has_vivarc(v, resources):
    html = os.path.join(resources, "window.html")
    return v.BEGIN in v.read_text(html) and os.path.isfile(os.path.join(resources, "vivarc.js"))


def reapply(app, data_dir, force=False):
    """Return (what happened, Vivaldi version). Raises on failure."""
    sys.path.insert(0, APP_DIR)
    import vivarc as v
    import windows_support as win

    win.configure(v, argparse.Namespace(app=app, data_dir=data_dir))
    resources = v.resource_dir(app)
    version = v.app_version(app)
    html_path = os.path.join(resources, "window.html")
    if not os.path.isfile(html_path):
        return "no-vivaldi", version
    if not force and has_vivarc(v, resources):
        return "in-place", version
    v.preflight(resources)
    v.write_bundle(resources, v.peek_enabled())  # reads ~/.vivarc (config, icons, peek), writes only into Vivaldi's folder
    v.write_atomic(html_path, v.inject_window_html(v.read_text(html_path)), newline="\n")
    if not has_vivarc(v, resources):
        raise RuntimeError(f"wrote Vivarc but it is still missing from {resources}")
    return "reapplied", version


def run(argv, output):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", default=DEFAULT_APP)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--force", action="store_true", help="re-apply even when Vivarc is in place (after a redeploy)")
    parser.add_argument("--no-toast", action="store_true")
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        args = parser.parse_args(argv)
        outcome, version = reapply(args.app.rstrip("\\/"), args.data_dir.rstrip("\\/"), args.force)
    return args, outcome, version


def main(argv=None):
    output = io.StringIO()  # pythonw has no console: keep every message for the log
    try:
        args, outcome, version = run(argv, output)
    except BaseException as error:  # includes SystemExit from argparse and from vivarc's die()
        said = output.getvalue().strip()
        trace = "" if isinstance(error, SystemExit) else "".join(traceback.format_exception(error)).strip()
        detail = "\n".join(part for part in (said, trace) if part) or repr(error)
        safe_log(f"FAILED: {detail}")
        if "--no-toast" not in (argv if argv is not None else sys.argv[1:]):
            toast("Revival Arc: re-apply failed", f"See {LOG}")
        return error.code if isinstance(error, SystemExit) and isinstance(error.code, int) and error.code else 1

    said = output.getvalue().strip()
    if said:  # a successful run can still have something to say, e.g. "Peek left out: ..."
        safe_log(said)
    if outcome == "reapplied":
        running = vivaldi_running()
        safe_log(f"{'force-' if args.force else ''}re-applied Vivarc to Vivaldi {version}"
                 + ("; Vivaldi is running, restart needed" if running else ""))
        if not args.no_toast:
            toast("Revival Arc re-applied",
                  f"Vivaldi {version} updated. Restart Vivaldi to bring the sidebar back." if running
                  else f"Vivarc is back on Vivaldi {version}.")
    elif outcome == "in-place":
        safe_log(f"Vivaldi {version} already has Vivarc; nothing to do")
    else:
        safe_log(f"no Vivaldi window.html under {args.app}; nothing to do")
    return 0


if __name__ == "__main__":
    sys.exit(main())
