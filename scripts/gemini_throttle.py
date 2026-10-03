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
        self.next_at = time.time() + float(config.get('request_interval_sec', 120))
        self.blocked_until = 0
        self.verification_required = False
        if self.path and self.path.exists():
            try:
                state = json.loads(self.path.read_text())
                self.next_at = max(self.next_at, float(state.get('next_at', 0)))
                self.blocked_until = float(state.get('blocked_until', 0))
                # Retire legacy manual pauses without resetting saved cooldown or spacing.
                if state.get('verification_required'):
                    self.save()
            except (ValueError, OSError): pass

    def save(self):
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix('.tmp')
            descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, 'w') as file:
                json.dump({'next_at': self.next_at, 'blocked_until': self.blocked_until,
                           'verification_required': self.verification_required}, file)
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
                except Exception as error:
                    self.blocked_until = time.time() + float(self.config.get('failure_cooldown_sec', 900))
                    raise
                finally:
                    self.next_at = time.time() + float(self.config.get('request_interval_sec', 120))
                    self.save()
        return call

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Migrate legacy pause state while retaining spacing and cooldown.')
    parser.add_argument('--resume-after-verification', action='store_true', required=True)
    parser.add_argument('--state-path', type=Path, default=Path(__file__).resolve().parent.parent / '.local-data/gemini-throttle.json')
    args = parser.parse_args()
    throttle = GatewayThrottle({}, args.state_path)
    throttle.verification_required = False
    throttle.save()
    print('网关使用冷却恢复；请求间隔和冷却时间保持不变。请重启 Gemini 网关。')
