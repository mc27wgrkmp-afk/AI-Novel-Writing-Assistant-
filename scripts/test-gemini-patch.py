"""Offline protocol regression tests for the pinned gateway patch."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import HTTPServer

class GatewayPatchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        target = Path(cls.temp.name) / 'gateway.py'
        target.write_text(Path('.local/gemini-web2api/gemini_web2api.py').read_text())
        subprocess.run([sys.executable, 'scripts/patch-gemini.py', str(target)], check=True)
        before = target.read_text()
        subprocess.run([sys.executable, 'scripts/patch-gemini.py', str(target)], check=True)
        assert before == target.read_text()
        spec = importlib.util.spec_from_file_location('patched_gateway', target)
        cls.gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.gateway)
        cls.gateway.CONFIG['log_requests'] = False
        cls.gateway.CONFIG['api_keys'] = []

    def probe(self, result=None, error=None):
        class Handler(self.gateway.GeminiHandler):
            def _call_gemini(self, *args):
                if error: raise RuntimeError(error)
                return result, None
            def log_message(self, *args): pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/chat/completions', data=json.dumps({'model': 'gemini-3.5-flash-thinking', 'messages': [{'role': 'user', 'content': 'test'}], 'stream': True}).encode(), headers={'Content-Type': 'application/json'})
        try:
            try:
                with urllib.request.urlopen(request) as response: return response.status, response.read().decode()
            except urllib.error.HTTPError as e: return e.code, e.read().decode()
        finally: server.shutdown(); server.server_close(); thread.join()

    def test_upstream_error_is_502_before_sse_headers(self):
        status, body = self.probe(error='upstream HTTP 405')
        self.assertEqual(status, 502); self.assertIn('405', body)
    def test_empty_content_is_not_a_successful_stream(self):
        status, body = self.probe(result='')
        self.assertEqual(status, 502); self.assertIn('empty content', body)
    def test_success_contains_content_and_done(self):
        status, body = self.probe(result='{"status":"ok"}')
        self.assertEqual(status, 200); self.assertIn('[DONE]', body)
        chunk = json.loads(body.splitlines()[0].removeprefix('data: '))
        self.assertEqual(chunk['choices'][0]['delta']['content'], '{"status":"ok"}')

if __name__ == '__main__': unittest.main()
