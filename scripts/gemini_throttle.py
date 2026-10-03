"""Serialize the local gateway and persist spacing/cooldown without storing prompts."""
import functools
import json
import os
from pathlib import Path
import threading
import time

class GatewayThrottle:
    def __init__(self, config, state_path=None):
        self.config = config
        self.path = Path(state_path) if state_path else None
        self.lock = threading.Lock()
        self.next_at = time.time() + float(config.get('request_interval_sec', 30))
        self.blocked_until = 0
        if self.path and self.path.exists():
            try:
                state = json.loads(self.path.read_text())
                self.next_at = max(self.next_at, float(state.get('next_at', 0)))
                self.blocked_until = float(state.get('blocked_until', 0))
            except (ValueError, OSError): pass

    def save(self):
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix('.tmp')
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, 'w') as file:
                json.dump({'next_at': self.next_at, 'blocked_until': self.blocked_until}, file)
            os.replace(temp, self.path)

    def limit(self, function):
        @functools.wraps(function)
        def call(*args, **kwargs):
            with self.lock:
                now = time.time()
                if now < self.blocked_until:
                    raise RuntimeError(f'Gateway cooling down after upstream failure; retry in {max(1, int(self.blocked_until - now))} seconds')
                time.sleep(max(0, self.next_at - now))
                try:
                    result = function(*args, **kwargs)
                    if isinstance(result, tuple) and not result[0]:
                        raise RuntimeError('Gemini upstream returned empty content')
                    return result
                except Exception:
                    self.blocked_until = time.time() + float(self.config.get('failure_cooldown_sec', 120))
                    raise
                finally:
                    self.next_at = time.time() + float(self.config.get('request_interval_sec', 30))
                    self.save()
        return call
