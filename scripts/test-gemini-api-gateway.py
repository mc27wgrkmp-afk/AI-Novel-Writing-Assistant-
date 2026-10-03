"""Offline integration tests: real SDK retry decorators, local HTTP, no Google calls."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import urllib.error
import urllib.request
from http.server import HTTPServer

from gemini_webapi.exceptions import APIError, AuthError
from gemini_gateway.hanaoka import ConservativeClient, HanaokaBackend, safe_error
from gemini_gateway.http import build_gateway
from gemini_throttle import GatewayThrottle

ROOT = Path(__file__).resolve().parent.parent


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_sdk_generation_decorator_sends_only_one_request_on_failure(self):
        for status in (429, 503):
            calls = []
            @asynccontextmanager
            async def stream(*args, **kwargs):
                calls.append(1)
                self.assertNotIn('current_retry', kwargs)  # Must be consumed by SDK decorator.
                yield SimpleNamespace(status_code=status)
            client = ConservativeClient()
            client._running = True
            client.client = SimpleNamespace(stream=stream)
            client.close = AsyncMock()
            with self.assertRaises(APIError):
                async for _ in client._generate('test', model=None):
                    pass
            self.assertEqual(calls, [1])

    async def test_real_sdk_rpc_decorator_sends_only_one_request_on_failure(self):
        client = ConservativeClient()
        client._running = True
        post = AsyncMock(return_value=SimpleNamespace(status_code=503))
        client.client = SimpleNamespace(post=post)
        client.close = AsyncMock()
        with self.assertRaises(APIError):
            await client._batch_execute([])
        self.assertEqual(post.await_count, 1)

    async def test_activity_requests_are_not_repeated_during_recovery(self):
        client = ConservativeClient()
        with patch('gemini_webapi.GeminiClient._sync_activity', new_callable=AsyncMock) as sync:
            await client._sync_activity()
            await client._sync_activity()
            self.assertEqual(sync.await_count, 1)


class GatewayTests(unittest.TestCase):
    def test_cookie_renewal_auth_failure_persists_pause_without_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'throttle.json'
            backend = HanaokaBackend({}, directory, {})
            backend.client = SimpleNamespace(_running=True, cookies={}, _live_client=object(), close=AsyncMock())
            throttle = GatewayThrottle({'request_interval_sec': 0, 'failure_cooldown_sec': 0}, state)
            try:
                with patch('gemini_gateway.hanaoka.rotate_1psidts', new_callable=AsyncMock) as rotate:
                    rotate.side_effect = AuthError('private')
                    with self.assertRaisesRegex(RuntimeError, 'Gemini paused'):
                        throttle.limit(lambda: backend.run(backend.renew_async()))()
                    with self.assertRaisesRegex(RuntimeError, 'manual recovery'):
                        throttle.limit(lambda: backend.run(backend.renew_async()))()
                    self.assertEqual(rotate.await_count, 1)
                    self.assertTrue(json.loads(state.read_text())['verification_required'])
            finally:
                backend.close()

    def test_guest_session_cannot_send_a_generation_request(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / 'cookie.json'
            cookie.write_text(json.dumps({'cookie': '__Secure-1PSID=fake; __Secure-1PSIDTS=fake-ts'}))
            backend = HanaokaBackend({'cookie_file': str(cookie)}, directory, {})
            guest = SimpleNamespace(init=AsyncMock(), _check_account_status=lambda: False,
                                    close=AsyncMock(), generate_content=AsyncMock())
            try:
                with patch('gemini_gateway.hanaoka.ConservativeClient', return_value=guest):
                    with self.assertRaisesRegex(RuntimeError, 'Gemini paused'):
                        backend.generate('test', 'gemini-flash')
                guest.generate_content.assert_not_called()
                self.assertFalse(backend.generation_verified)
            finally:
                backend.close()

    def test_typed_and_http_status_errors_pause_without_leaking_credentials(self):
        for error in (AuthError('private-secret'), APIError('Status: 429 private-secret'), APIError('captcha private-secret')):
            throttle = GatewayThrottle({'request_interval_sec': 0})
            def fail():
                raise safe_error(error)
            with self.assertRaisesRegex(RuntimeError, 'verification required') as caught:
                throttle.limit(fail)()
            self.assertNotIn('private-secret', str(caught.exception))
            self.assertIn(type(error).__name__, str(caught.exception))
            self.assertTrue(throttle.verification_required)

    def test_old_flash_alias_resolves_to_live_account_model_and_does_not_fallback_to_pro(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = HanaokaBackend({}, directory, {'gemini-3.8-flash': {'mode': 1}})
            flash = SimpleNamespace(model_name='gemini-fast')
            def resolve(name):
                if name == 'gemini-fast':
                    return flash
                raise ValueError('missing')
            backend.client = SimpleNamespace(resolve_model=resolve, close=AsyncMock())
            try:
                self.assertIs(backend.resolve('gemini-3.8-flash'), flash)
                with self.assertRaises(ValueError):
                    backend.resolve('gemini-unavailable-pro')
            finally:
                backend.close()

    def test_http_listing_and_paused_generation_never_initialize_upstream(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            state = path / 'state.json'
            state.write_text(json.dumps({'verification_required': True, 'next_at': 0, 'blocked_until': 0}))
            config = path / 'config.json'
            config.write_text(json.dumps({'log_requests': False, 'api_keys': [], 'throttle_state_file': str(state)}))
            with patch('gemini_gateway.http.HanaokaBackend') as factory:
                backend = factory.return_value
                backend.catalogue.return_value = {'gemini-flash': {'mode': 'gemini-flash', 'think': 0, 'desc': 'test'}}
                backend.generation_verified = False
                backend.selected_model = None
                _, handler, _ = build_gateway(ROOT, config)
                server = HTTPServer(('127.0.0.1', 0), handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f'http://127.0.0.1:{server.server_port}'
                try:
                    for _ in range(3):
                        with urllib.request.urlopen(url + '/v1/models') as response:
                            self.assertEqual(json.load(response)['data'][0]['id'], 'gemini-flash')
                    request = urllib.request.Request(url + '/v1/chat/completions',
                        data=json.dumps({'model': 'gemini-flash', 'stream': True,
                                         'messages': [{'role': 'user', 'content': 'test'}]}).encode(),
                        headers={'Content-Type': 'application/json'})
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(request)
                    self.assertEqual(caught.exception.code, 502)
                    self.assertIn('Gemini paused', caught.exception.read().decode())
                    backend.generate.assert_not_called()
                    self.assertTrue(json.loads(state.read_text())['verification_required'])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_success_and_empty_output_are_distinguished(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = HanaokaBackend({}, directory, {})
            backend.client = SimpleNamespace(close=AsyncMock(), cookies={})
            backend.initialize = AsyncMock()
            backend.resolve = lambda name: SimpleNamespace(model_name='gemini-fast')
            backend.client.generate_content = AsyncMock(return_value=SimpleNamespace(text='OK'))
            try:
                with patch('gemini_gateway.hanaoka.save_cookies'):
                    self.assertEqual(backend.generate('test', 'gemini-flash'), 'OK')
                    self.assertTrue(backend.generation_verified)
                    backend.client.generate_content.return_value = SimpleNamespace(text='')
                    with self.assertRaises(RuntimeError):
                        backend.generate('test', 'gemini-flash')
                    self.assertFalse(backend.generation_verified)
                self.assertEqual(backend.client.generate_content.await_count, 2)
            finally:
                backend.close()


if __name__ == '__main__':
    unittest.main()
