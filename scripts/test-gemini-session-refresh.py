"""Offline credential replacement and privacy regression checks."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("refresh", Path(__file__).with_name("refresh-gemini-session.py"))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTest(unittest.TestCase):
    def test_refresh_rejects_cross_origin_redirect_before_transmission(self):
        handler = refresh.SameOriginRedirectHandler()
        request = urllib.request.Request("https://gemini.google.com/app", headers={"Cookie": "private"})
        for url in ["https://accounts.google.com/login", "https://www.google.com/sorry/index", "https://example.com/", "http://gemini.google.com/app"]:
            with self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, "Found", {}, url)
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://gemini.google.com/u/1/app")
        self.assertEqual(redirected.get_header("Cookie"), "private")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cookie = self.root / "cookie.txt"
        self.cookie.write_text("old-private-cookie")
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"cookie_file": str(self.cookie), "proxy": "http://127.0.0.1:7890",
                                         "api_keys": ["private-key"], "xsrf_token": "old-token", "auth_user": 1}))
        self.before = self.config.read_bytes()
        self.backups = self.root / "backups"

    def test_logged_out_page_does_not_modify_files(self):
        with self.assertRaises(ValueError):
            refresh.refresh_session(self.config, "SAPISID=private", self.backups,
                                    lambda *_: ("https://gemini.google.com/app", '<button aria-label="Sign in">'))
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertEqual(self.cookie.read_text(), "old-private-cookie")
        self.assertFalse(self.backups.exists())

    def test_challenge_redirect_cannot_update_session(self):
        with self.assertRaises(ValueError):
            refresh.refresh_session(self.config, "SAPISID=private", self.backups,
                                    lambda *_: ("https://www.google.com/sorry/index", '"SNlM0e":"private","cfb2h":"build"'))
        self.assertEqual(self.config.read_bytes(), self.before)

    def test_authenticated_snapshot_preserves_configuration_and_private_backups(self):
        backup = refresh.refresh_session(self.config, "Cookie: SAPISID=new-private; SID=sid", self.backups,
                                         lambda *_: ("https://gemini.google.com/u/1/app", '"SNlM0e":"new-token","cfb2h":"new-build"'))
        config = json.loads(self.config.read_text())
        self.assertEqual(config["api_keys"], ["private-key"])
        self.assertEqual(config["proxy"], "http://127.0.0.1:7890")
        self.assertEqual(config["auth_user"], 1)
        self.assertEqual(config["xsrf_token"], "new-token")
        self.assertEqual(config["gemini_bl"], "new-build")
        self.assertEqual(json.loads(self.cookie.read_text())["sapisid"], "new-private")
        self.assertEqual((backup / "config.json").read_bytes(), self.before)
        self.assertEqual((backup / "cookie.txt").read_text(), "old-private-cookie")
        for path in [self.config, self.cookie, backup / "config.json", backup / "cookie.txt"]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)

    def test_refresh_saves_response_cookie_updates_with_validated_page(self):
        refresh.refresh_session(self.config, "SAPISID=old; SID=keep", self.backups,
                                lambda *_: ("https://gemini.google.com/u/1/app", '"SNlM0e":"token","cfb2h":"build"', "SAPISID=rotated; SID=keep"))
        data = json.loads(self.cookie.read_text())
        self.assertEqual(data["cookie"], "SAPISID=rotated; SID=keep")
        self.assertEqual(data["sapisid"], "rotated")

    def test_failure_output_never_echoes_clipboard_or_exception(self):
        output = io.StringIO()
        with patch("sys.argv", ["refresh-gemini-session.py", "--clipboard"]), patch.object(refresh.sys, "platform", "darwin"), \
             patch.object(refresh.subprocess, "run", side_effect=RuntimeError("private-cookie-secret")), \
             contextlib.redirect_stderr(output):
            self.assertEqual(refresh.main(), 1)
        self.assertNotIn("private-cookie-secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
