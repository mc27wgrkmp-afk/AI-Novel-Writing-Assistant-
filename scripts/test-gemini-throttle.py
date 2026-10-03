import tempfile
from pathlib import Path
import threading
import time
import unittest
from gemini_throttle import GatewayThrottle

class ThrottleTests(unittest.TestCase):
    def test_parallel_calls_are_serial_and_spaced_from_completion(self):
        throttle = GatewayThrottle({'request_interval_sec': .04})
        starts, ends = [], []
        @throttle.limit
        def invoke():
            starts.append(time.time()); time.sleep(.02); ends.append(time.time())
            return ('ok', None)
        threads = [threading.Thread(target=invoke) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(len(starts), 3)
        for index in range(1, 3): self.assertGreaterEqual(starts[index] - ends[index - 1], .035)

    def test_failure_cooldown_survives_restart_without_reinvoking_upstream(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            config = {'request_interval_sec': 0, 'failure_cooldown_sec': .2}
            calls = []
            @GatewayThrottle(config, path).limit
            def rejected(): calls.append(1); raise RuntimeError('upstream rejected')
            with self.assertRaisesRegex(RuntimeError, 'upstream rejected'): rejected()
            @GatewayThrottle(config, path).limit
            def after_restart(): calls.append(2); return ('ok', None)
            with self.assertRaisesRegex(RuntimeError, 'cooling down'): after_restart()
            self.assertEqual(calls, [1])
            time.sleep(.21)
            self.assertEqual(after_restart(), ('ok', None))

    def test_empty_output_also_opens_cooldown(self):
        throttle = GatewayThrottle({'request_interval_sec': 0, 'failure_cooldown_sec': 1})
        call = throttle.limit(lambda: ('', None))
        with self.assertRaisesRegex(RuntimeError, 'empty content'): call()
        with self.assertRaisesRegex(RuntimeError, 'cooling down'): call()

    def test_verification_pause_survives_cooldown_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            config = {'request_interval_sec': 0, 'failure_cooldown_sec': 0}
            calls = []
            @GatewayThrottle(config, path).limit
            def challenged():
                calls.append(1)
                raise RuntimeError('Gemini verification required: /sorry/')
            with self.assertRaisesRegex(RuntimeError, 'verification required'):
                challenged()
            @GatewayThrottle(config, path).limit
            def after_restart():
                calls.append(2)
                return ('ok', None)
            for _ in range(3):
                with self.assertRaisesRegex(RuntimeError, 'manual recovery'):
                    after_restart()
            self.assertEqual(calls, [1])

    def test_rate_limit_requires_manual_recovery(self):
        import urllib.error
        throttle = GatewayThrottle({'request_interval_sec': 0})
        def reject():
            raise urllib.error.HTTPError('https://example.invalid', 429, 'Too many requests', {}, None)
        with self.assertRaises(urllib.error.HTTPError):
            throttle.limit(reject)()
        self.assertTrue(throttle.verification_required)
        with self.assertRaisesRegex(RuntimeError, 'manual recovery'):
            throttle.limit(lambda: ('ok', None))()

    def test_explicit_resume_preserves_cooldown_and_spacing(self):
        import json
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            next_at = time.time() + 600
            blocked_until = time.time() + 900
            path.write_text(json.dumps({'next_at': next_at, 'blocked_until': blocked_until, 'verification_required': True}))
            subprocess.run([sys.executable, str(Path(__file__).with_name('gemini_throttle.py')),
                            '--resume-after-verification', '--state-path', str(path)], check=True, capture_output=True)
            state = json.loads(path.read_text())
            self.assertFalse(state['verification_required'])
            self.assertEqual(state['next_at'], next_at)
            self.assertEqual(state['blocked_until'], blocked_until)

if __name__ == '__main__': unittest.main()
