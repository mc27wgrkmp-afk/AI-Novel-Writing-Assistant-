"""Reject nested Bard errors and empty completions in the pinned gateway."""
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
source = source.replace(r"r'BardErrorInfo\s*\[(\d+)\]'", r"r'BardErrorInfo[^\[]*\[\s*(\d+)'" )
source = source.replace('        msg = {"role": "assistant", "content": text or None}', '        if not text.strip():\n            self.send_json({"error": {"message": "Gemini upstream returned empty content; check upstream access or authentication"}}, 502)\n            return\n        msg = {"role": "assistant", "content": text}')
path.write_text(source)
