"""Pinned Gemini-API transport with conservative request and credential policies."""
import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
import threading
import time

from gemini_webapi import GeminiClient
from gemini_webapi.exceptions import AuthError, TemporarilyBlockedError, UsageLimitExceededError
from gemini_webapi.utils.rotate_1psidts import rotate_1psidts, save_cookies
from loguru import logger

logger.disable('gemini_webapi')  # Library diagnostics may include private cache paths.


class ConservativeClient(GeminiClient):
    """Keep protocol support, without hidden generation/RPC resubmission."""
    async def _generate(self, *args, **kwargs):
        kwargs['current_retry'] = 0
        async for output in super()._generate(*args, **kwargs):
            yield output

    async def _batch_execute(self, *args, **kwargs):
        kwargs['current_retry'] = 0
        return await super()._batch_execute(*args, **kwargs)

    async def _sync_activity(self):
        # Generation and history recovery both call this; avoid duplicate heartbeats.
        previous = getattr(self, '_factory_activity_at', 0)
        if time.monotonic() - previous < 1200:
            return
        self._factory_activity_at = time.monotonic()
        await super()._sync_activity()

    async def _fetch_usage_info(self):
        previous = getattr(self, '_factory_usage_at', 0)
        if time.monotonic() - previous < 1200:
            return
        self._factory_usage_at = time.monotonic()
        return await super()._fetch_usage_info()

    async def read_chat(self, *args, **kwargs):
        # History recovery may read the existing result, but never resend its prompt.
        previous = getattr(self, '_factory_history_at', 0)
        await asyncio.sleep(max(0, previous + 60 - time.monotonic()))
        self._factory_history_at = time.monotonic()
        return await super().read_chat(*args, **kwargs)


def safe_error(error):
    """Expose useful classification without upstream URLs, cookies or account data."""
    status = getattr(getattr(error, 'response', None), 'status_code', None)
    restricted = bool(re.search(r'(?:Status:|HTTP(?: Error)?)\s*(?:401|403|429)\b|captcha|verification required|/sorry/|unusual traffic|BardErrorInfo', str(error), re.IGNORECASE))
    if isinstance(error, (AuthError, TemporarilyBlockedError, UsageLimitExceededError)) or status in (401, 403, 429) or restricted:
        return RuntimeError('Gemini paused: verification required (' + type(error).__name__ + '); login, quota or upstream restriction requires manual recovery; automatic retries are disabled')
    return RuntimeError('Gemini upstream failed (' + type(error).__name__ + '); automatic retries are disabled')


class HanaokaBackend:
    def __init__(self, config, data_dir, legacy_models):
        self.config = config
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.data_dir.chmod(0o700)
        self.models_path = self.data_dir / 'available-models.json'
        self.legacy_models = legacy_models
        self.client = None
        self.models = []
        self.selected_model = None
        self.generation_verified = False
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.stop = threading.Event()
        self.renewal_thread = None
        self.model_lock = threading.Lock()
        try:
            self.models = json.loads(self.models_path.read_text())
        except (OSError, ValueError):
            pass

    def run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()

    async def initialize(self):
        if self.client and self.client._running:
            return
        if self.config.get('auth_user') not in (None, '', 0, '0'):
            raise AuthError('This adapter requires the default Google account session')
        if self.client:
            await self.client.close()
        path = Path(self.config['cookie_file'])
        raw = path.read_bytes()
        data = json.loads(raw) if raw.lstrip().startswith(b'{') else {'cookie': raw.decode()}
        pairs = dict(part.strip().split('=', 1) for part in data['cookie'].split(';') if '=' in part)
        if not pairs.get('__Secure-1PSID') or not pairs.get('__Secure-1PSIDTS'):
            raise AuthError('Missing required session cookies')
        # A manually replaced credential snapshot gets a separate cache namespace.
        # Keep raw credential values out of paths, diagnostics and the Git tree.
        cache = self.data_dir / ('session-' + hashlib.sha256(raw).hexdigest()[:16])
        cache.mkdir(mode=0o700, exist_ok=True)
        cache.chmod(0o700)
        os.environ['GEMINI_COOKIE_PATH'] = str(cache)
        self.client = ConservativeClient(pairs['__Secure-1PSID'], pairs['__Secure-1PSIDTS'], proxy=self.config.get('proxy'))
        # No idle heartbeat; renewal is explicitly scheduled through the shared throttle.
        await self.client.init(timeout=max(180, float(self.config.get('request_timeout_sec', 180))),
                               auto_refresh=False, verbose=False, watchdog_timeout=180)
        if not self.client._check_account_status():  # Never generate as a guest.
            raise AuthError('Signed-in session is unavailable')
        self.update_models()
        save_cookies(self.client.cookies, verbose=False)

    def update_models(self):
        models = [{ 'id': model.model_name, 'description': model.description,
                    'display_name': model.display_name, 'aliases': model.aliases }
                  for model in self.client.list_models() or [] if model.is_available]
        if not models:
            raise AuthError('No available signed-in models')
        with self.model_lock:
            self.models = models
            temp = self.models_path.with_suffix('.tmp')
            fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as out:
                json.dump(models, out, ensure_ascii=False)
            os.replace(temp, self.models_path)

    def catalogue(self):
        with self.model_lock:
            models = list(self.models)
        entries = {item['id']: {'mode': item['id'], 'think': 0,
                               'desc': item['display_name'] + ': ' + item['description']} for item in models}
        # Before login, these are route choices, not a claim of verified availability.
        for name in ('gemini-flash', 'gemini-thinking', 'gemini-pro', 'gemini-auto'):
            entries.setdefault(name, {'mode': name, 'think': 0, 'desc': 'Web model route; availability checked when generating'})
        for name in self.legacy_models:
            entries.setdefault(name, {'mode': name, 'think': 0, 'desc': 'Compatibility Web route; actual model follows account availability'})
        return entries

    def resolve(self, name):
        if name == 'gemini-auto':
            return None
        # Exact account names/aliases take precedence over old gateway aliases.
        try:
            return self.client.resolve_model(name)
        except ValueError:
            mode = self.legacy_models.get(name, {}).get('mode')
            candidates = {1: ('gemini-flash', 'gemini-fast'), 2: ('gemini-thinking',),
                          3: ('gemini-pro',), 5: ('gemini-thinking',),
                          6: ('gemini-flash-lite',)}.get(mode, ())
            if mode == 4:
                return None
            for candidate in candidates:
                try:
                    return self.client.resolve_model(candidate)
                except ValueError:
                    pass
            raise ValueError('Selected model is not available for this account; choose an available Web model') from None

    async def generate_async(self, prompt, name):
        try:
            self.generation_verified = False
            await self.initialize()
            selected = self.resolve(name)
            self.selected_model = selected.model_name if selected else 'account-default'
            response = await self.client.generate_content(prompt, model=selected,
                         temporary=self.config.get('temporary_chats', True))
            save_cookies(self.client.cookies, verbose=False)
            if not response.text.strip():
                raise RuntimeError('EmptyContent')
            self.generation_verified = True
            return response.text
        except Exception as error:
            self.generation_verified = False
            if self.client:
                await self.client.close()
            raise safe_error(error) from None

    def generate(self, prompt, name):
        return self.run(self.generate_async(prompt, name))

    async def renew_async(self):
        # No initialization while idle; only maintain a session already used successfully.
        if not self.client or not self.client._running:
            return ('idle', None)
        try:
            _, cookies = await rotate_1psidts(self.client.cookies, self.client._live_client, verbose=False)
            self.client._cookies.update(cookies)
            return ('renewed', None)
        except Exception as error:
            self.generation_verified = False
            await self.client.close()
            raise safe_error(error) from None

    def start_renewal(self, throttle):
        def maintain():
            interval = max(1200, float(self.config.get('session_refresh_interval_sec', 1200)))
            while not self.stop.wait(interval):
                if not self.client or not self.client._running:
                    continue
                try:
                    throttle.limit(lambda: self.run(self.renew_async()))()
                except Exception:
                    # Throttle persisted the pause/cooldown. Never recover on its own.
                    pass
        self.renewal_thread = threading.Thread(target=maintain, daemon=True)
        self.renewal_thread.start()

    def close(self):
        self.stop.set()
        if self.client:
            self.run(self.client.close())
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)
