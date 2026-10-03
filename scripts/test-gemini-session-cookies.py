import json
from email.message import Message
from pathlib import Path
import tempfile
import unittest
import urllib.request
from gemini_session_cookies import merge_response_cookies, persist_response_cookies


class Response:
    def __init__(self, cookie, url='https://gemini.google.com/app'):
        self.url = url
        self.headers = Message()
        self.headers.add_header('Set-Cookie', cookie)
    def info(self): return self.headers
    def geturl(self): return self.url


class CookieTests(unittest.TestCase):
    def setUp(self):
        self.request = urllib.request.Request('https://gemini.google.com/app')

    def test_rotation_merges_accepted_cookie_and_preserves_other_values(self):
        response = Response('__Secure-1PSIDTS=new; Domain=.google.com; Path=/; Secure')
        cookie = merge_response_cookies('SAPISID=private; __Secure-1PSIDTS=old', response, self.request)
        self.assertEqual(cookie, 'SAPISID=private; __Secure-1PSIDTS=new')

    def test_foreign_origin_and_foreign_cookie_domain_are_not_trusted(self):
        with self.assertRaises(ValueError):
            merge_response_cookies('SAPISID=private', Response('SAPISID=bad', 'https://example.com/'), self.request)
        cookie = merge_response_cookies('SAPISID=private', Response('SAPISID=bad; Domain=example.com'), self.request)
        self.assertEqual(cookie, 'SAPISID=private')

    def test_update_is_private_and_preserves_backup_and_sapisid_consistency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cookie.json'
            original = json.dumps({'cookie': 'SAPISID=old; SID=keep', 'sapisid': 'old'})
            path.write_text(original)
            response = Response('SAPISID=new; Domain=.google.com; Path=/; Secure')
            persist_response_cookies({'cookie_file': str(path)}, response, self.request)
            saved = json.loads(path.read_text())
            self.assertEqual(saved, {'cookie': 'SAPISID=new; SID=keep', 'sapisid': 'new'})
            backup = next(Path(directory).glob('.gemini-cookie-before-rotation-*'))
            self.assertEqual(backup.read_text(), original)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__': unittest.main()
