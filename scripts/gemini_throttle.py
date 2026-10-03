"""Serialize the local gateway and persist spacing/cooldown without storing prompts."""
import functools
import json
import os
import re
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
                self.verification_required = bool(state.get('verification_required', False))
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
                if self.verification_required:
                    raise RuntimeError('Gemini paused: verification or upstream restriction requires manual recovery; automatic retries are disabled')
                if now < self.blocked_until:
                    raise RuntimeError(f'Gateway cooling down after upstream failure; retry in {max(1, int(self.blocked_until - now))} seconds')
                time.sleep(max(0, self.next_at - now))
                try:
                    result = function(*args, **kwargs)
                    if isinstance(result, tuple) and not result[0]:
                        raise RuntimeError('Gemini upstream returned empty content')
                    return result
                except Exception as error:
                    status = getattr(error, 'code', None) or getattr(getattr(error, 'response', None), 'status_code', None)
                    # Safety guard on an upstream failure, not an attempt to solve verification.
                    self.verification_required = status in (401, 403, 429) or bool(re.search(
                        r'captcha|recaptcha|verification required|/sorry/|unusual traffic|BardErrorInfo|HTTP (?:Error )?(?:401|403|429)',
                        str(error), re.IGNORECASE))
                    self.blocked_until = time.time() + float(self.config.get('failure_cooldown_sec', 900))
                    raise
                finally:
                    self.next_at = time.time() + float(self.config.get('request_interval_sec', 120))
                    self.save()
        return call

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Resume only after manually resolving Gemini verification; retains spacing and cooldown.')
    parser.add_argument('--resume-after-verification', action='store_true', required=True)
    parser.add_argument('--state-path', type=Path, default=Path(__file__).resolve().parent.parent / '.local-data/gemini-throttle.json')
    args = parser.parse_args()
    throttle = GatewayThrottle({}, args.state_path)
    throttle.verification_required = False
    throttle.save()
    print('已清除人工验证暂停标记；请求间隔和冷却仍保留。请重启 Gemini 网关。')
