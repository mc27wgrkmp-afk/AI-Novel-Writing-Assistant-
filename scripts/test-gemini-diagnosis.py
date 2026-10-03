"""Check session classification and secret redaction without network access."""
import importlib.util
from pathlib import Path
import unittest
import urllib.error
import urllib.request
import json
import io
import tempfile
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location("diagnosis", Path(__file__).with_name("diagnose-gemini.py"))
diagnosis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnosis)


class DiagnosisTest(unittest.TestCase):
    def test_generation_probe_keeps_known_error_type_without_private_message(self):
        local = MagicMock()
        local.open.side_effect = urllib.error.HTTPError('http://127.0.0.1/', 502, 'failed', {},
            io.BytesIO(b'Gateway cooling down after upstream failure; upstream restriction (AuthError); private-cookie'))
        report = {}
        diagnosis.probe_generation({}, local, 'http://127.0.0.1:8081/v1', {}, report)
        self.assertEqual(report['generation']['upstreamErrorType'], 'AuthError')
        self.assertFalse(report['generation']['manualRecoveryRequired'])
        self.assertTrue(report['generation']['coolingDown'])
        self.assertNotIn('private-cookie', str(report))

    def test_hanaoka_offline_gateway_diagnosis_never_falls_back_to_google(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / '.local/gemini-web2api/config.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'gateway_engine': 'hanaoka'}))
            local = MagicMock()
            local.open.side_effect = OSError('offline')
            with patch.object(diagnosis, 'ROOT', Path(directory)), \
                 patch('sys.argv', ['diagnose-gemini.py']), \
                 patch.object(diagnosis.urllib.request, 'build_opener', return_value=local), \
                 patch('builtins.print'):
                diagnosis.main()
            self.assertEqual(local.open.call_count, 2)
            for call in local.open.call_args_list:
                self.assertTrue(call.args[0].full_url.startswith('http://127.0.0.1:'))

    def test_cross_origin_redirect_strips_credentials(self):
        handler = diagnosis.CredentialRedirectHandler()
        request = urllib.request.Request("https://gemini.google.com/app", headers={"Cookie": "private", "Authorization": "private-auth"})
        for url in ["https://accounts.google.com/login", "https://www.google.com/sorry/index", "https://example.com/", "http://gemini.google.com/app"]:
            redirected = handler.redirect_request(request, None, 302, "Found", {}, url)
            self.assertIsNone(redirected.get_header("Cookie"))
            self.assertIsNone(redirected.get_header("Authorization"))
        same_origin = handler.redirect_request(request, None, 302, "Found", {}, "https://gemini.google.com/u/1/app")
        self.assertEqual(same_origin.get_header("Cookie"), "private")

    def test_logged_out_page_is_not_confused_with_authenticated_page(self):
        state = diagnosis.describe_page(200, "https://gemini.google.com/app", '<button aria-label="Sign in">Sign in</button>')
        self.assertTrue(state["signInButton"])
        self.assertFalse(state["sessionTokenPresent"])
        signed_in = diagnosis.describe_page(200, "https://gemini.google.com/app", '"SNlM0e":"private-token"')
        self.assertTrue(signed_in["sessionTokenPresent"])
        self.assertNotIn("private-token", str(signed_in))

    def test_challenge_and_login_redirects_discard_url_secrets(self):
        challenge = diagnosis.describe_page(200, "https://www.google.com/sorry/index?token=private", "")
        self.assertTrue(challenge["googleChallenge"])
        self.assertNotIn("private", str(challenge))
        login = diagnosis.describe_page(200, "https://accounts.google.com/login?continue=private", "")
        self.assertTrue(login["loginRedirect"])
        self.assertNotIn("private", str(login))

    def test_error_text_cannot_expose_credentials(self):
        error = urllib.error.HTTPError("https://google.com/?secret=private", 405, "private-cookie", {}, None)
        self.assertEqual(diagnosis.error_description(error), {"type": "http", "status": 405})
        self.assertEqual(diagnosis.error_description(RuntimeError("private-token")), {"type": "RuntimeError"})


if __name__ == "__main__":
    unittest.main()
