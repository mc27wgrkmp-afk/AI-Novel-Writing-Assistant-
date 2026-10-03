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

# Gate all OpenAI calls, including repairs, before touching Google.
source = path.read_text()
marker = "# FACTORY_GATEWAY_THROTTLE"
if marker in source:
    start = source.index(marker)
    end = source.index('class GeminiHandler(BaseHTTPRequestHandler):', start)
    source = source[:start] + source[end:]
helper_dir = str(Path(__file__).resolve().parent)
injection = marker + "\nimport sys as _factory_sys\n_factory_sys.path.insert(0, " + repr(helper_dir) + ")\nfrom gemini_throttle import GatewayThrottle\n_factory_throttle = GatewayThrottle(CONFIG, CONFIG.get('throttle_state_file'))\n\n"
source = source.replace('class GeminiHandler(BaseHTTPRequestHandler):', injection + 'class GeminiHandler(BaseHTTPRequestHandler):')
source = source.replace('    @_factory_throttle.limit\n', '')
source = source.replace('    def _call_gemini(self,', '    @_factory_throttle.limit\n    def _call_gemini(self,')
path.write_text(source)
