"""Reuse the pinned OpenAI/Google HTTP contract, replacing only its transport."""
import importlib.util
import json
from http.server import HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

from gemini_throttle import GatewayThrottle
from .hanaoka import HanaokaBackend


def build_gateway(root, config_path):
    spec = importlib.util.spec_from_file_location('factory_gemini_http', root / '.local/gemini-web2api/gemini_web2api.py')
    gateway = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gateway)
    gateway.CONFIG.update(json.loads(config_path.read_text()))
    config = gateway.CONFIG
    if config.get('cookie_file') and not Path(config['cookie_file']).is_absolute():
        config['cookie_file'] = str(config_path.parent / config['cookie_file'])
    config['request_interval_sec'] = max(120, float(config.get('request_interval_sec', 120)))
    config['failure_cooldown_sec'] = max(900, float(config.get('failure_cooldown_sec', 900)))
    config['retry_attempts'] = 1
    throttle = GatewayThrottle(config, config.get('throttle_state_file', root / '.local-data/gemini-throttle.json'))
    backend = HanaokaBackend(config, root / '.local-data/gemini-api', dict(gateway.MODELS))
    gateway.MODELS = backend.catalogue()

    def reject_images(images):
        if images:
            raise RuntimeError('Gemini local writing gateway supports text input only')
        return []
    gateway.upload_images = reject_images  # Never invoke the legacy Google uploader.

    class Handler(gateway.GeminiHandler):
        def _resolve_model(self, model_name):
            # Resolution against live account capabilities happens inside the throttle.
            if '@think=' in model_name:
                return None, None, None, 'Use an available Web model; think overrides are unsupported'
            return model_name, model_name, 0, None

        @throttle.limit
        def _call_gemini(self, prompt, model_id, think_mode, tools, file_refs=None):
            if file_refs:
                raise RuntimeError('Gemini local writing gateway supports text input only')
            text = backend.generate(prompt, model_id)
            gateway.MODELS = backend.catalogue()
            return gateway.parse_tool_calls(text) if tools else (text, None)

        def do_GET(self):
            gateway.MODELS = backend.catalogue()
            if self.path == '/':
                self.send_json({'status': 'ok', 'backend': 'hanaoka',
                                'generation_verified': backend.generation_verified,
                                'selected_model': backend.selected_model,
                                'verification_required': throttle.verification_required,
                                'next_at': throttle.next_at, 'blocked_until': throttle.blocked_until,
                                'models': list(gateway.MODELS)})
                return
            super().do_GET()

    backend.start_renewal(throttle)
    return config, Handler, backend


def serve(root, config_path):
    config, handler, backend = build_gateway(root, config_path)

    class Server(ThreadingMixIn, HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    server = Server((config.get('host', '127.0.0.1'), int(config.get('port', 8081))), handler)
    print('Gemini gateway: Hanaoka Gemini-API; serial requests; no automatic resubmission', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        backend.close()
