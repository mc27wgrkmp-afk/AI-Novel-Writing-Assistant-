"""Reject nested Bard errors and empty completions in the pinned gateway."""
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
source = source.replace(r"r'BardErrorInfo\s*\[(\d+)\]'", r"r'BardErrorInfo[^\[]*\[\s*(\d+)'" )
source = source.replace('        msg = {"role": "assistant", "content": text or None}', '        if not text.strip():\n            self.send_json({"error": {"message": "Gemini upstream returned empty content; check upstream access or authentication"}}, 502)\n            return\n        msg = {"role": "assistant", "content": text}')
path.write_text(source)

# Buffer one upstream response before sending SSE headers, so rejection remains HTTP 502.
source = path.read_text()
start = source.index('        if stream and not tools:')
end = source.index('        # Non-streaming (or tool calling which needs full response)', start)
source = source[:start] + '        if stream and not tools:\n            # Buffered SSE: validate upstream before returning HTTP success.\n            try:\n                text, _ = self._call_gemini(prompt, model_id, think_mode, tools, file_refs)\n                if not text.strip():\n                    raise RuntimeError("Gemini upstream returned empty content; check upstream access or authentication")\n            except Exception as e:\n                self.send_json({"error": {"message": f"upstream error: {e}"}}, 502)\n                return\n            try:\n                self.send_response(200)\n                self.send_header("Content-Type", "text/event-stream")\n                self.send_header("Cache-Control", "no-cache")\n                self.send_header("Access-Control-Allow-Origin", "*")\n                self.end_headers()\n                chunk = {"id": cid, "object": "chat.completion.chunk", "created": int(time.time()), "model": model_name,\n                         "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]}\n                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\\n\\n".encode())\n                chunk["choices"] = [{"index": 0, "delta": {}, "finish_reason": "stop"}]\n                self.wfile.write(f"data: {json.dumps(chunk)}\\n\\ndata: [DONE]\\n\\n".encode())\n                self.wfile.flush()\n            except (BrokenPipeError, ConnectionResetError):\n                pass\n            return\n\n' + source[end:]
path.write_text(source)

# A verification HTML page must not become an empty successful response.
source = path.read_text()
raw_call = '\n        raw = gemini_stream_generate(prompt, model_id, think_mode, file_refs)'
html_guard = '\n        if raw.lstrip().lower().startswith(("<!doctype html", "<html")):\n            raise RuntimeError("Gemini verification required: upstream returned HTML instead of a response")'
if html_guard not in source:
    source = source.replace(raw_call, raw_call + html_guard)
path.write_text(source)

# Gate all OpenAI calls, including repairs, before touching Google.
source = path.read_text()
marker = "# FACTORY_GATEWAY_THROTTLE"
if marker in source:
    start = source.index(marker)
    end = source.index('class GeminiHandler(BaseHTTPRequestHandler):', start)
    source = source[:start] + source[end:]
helper_dir = str(Path(__file__).resolve().parent)
injection = marker + """
CONFIG['retry_attempts'] = 1
import sys as _factory_sys
import threading as _factory_threading
import functools as _factory_functools
""" + "_factory_sys.path.insert(0, " + repr(helper_dir) + ")\n" + """from gemini_throttle import GatewayThrottle
from gemini_session_cookies import persist_response_cookies as _factory_persist_response_cookies
_factory_throttle = None
_factory_throttle_init_lock = _factory_threading.Lock()

def _factory_limit(function):
    @_factory_functools.wraps(function)
    def limited(*args, **kwargs):
        global _factory_throttle
        # main() loads config after module import; defer construction until then.
        with _factory_throttle_init_lock:
            if _factory_throttle is None:
                _factory_throttle = GatewayThrottle(CONFIG, CONFIG.get('throttle_state_file'))
            throttle = _factory_throttle
        return throttle.limit(function)(*args, **kwargs)
    return limited

"""
source = source.replace('class GeminiHandler(BaseHTTPRequestHandler):', injection + 'class GeminiHandler(BaseHTTPRequestHandler):')
source = source.replace('    @_factory_throttle.limit\n', '').replace('    @_factory_limit\n', '')
source = source.replace('    def _call_gemini(self,', '    @_factory_limit\n    def _call_gemini(self,')
path.write_text(source)

# Save accepted Set-Cookie updates before reading generation responses.
source = path.read_text()
line = '            return resp.read().decode("utf-8", errors="replace")'
rotation = '            _factory_persist_response_cookies(CONFIG, resp, req)\n'
if rotation + line not in source:
    source = source.replace(line, rotation + line)
path.write_text(source)

# The web protocol selects Fast, not a pinned API version. Keep the alias honest.
source = path.read_text()
if '"gemini-3.8-flash":' not in source:
    source = source.replace('MODELS = {', 'MODELS = {\n    "gemini-3.8-flash": {\n        "mode": 1, "think": 4,\n        "desc": "Gemini 3.8 Flash (Web Fast alias; actual version follows upstream rollout)",\n    },', 1)
path.write_text(source)
