#!/usr/bin/env bash
set -euo pipefail
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_GATEWAY="$FACTORY_ROOT/.local/gemini-web2api"
if [[ ! -f "$FACTORY_GATEWAY/gemini_web2api.py" ]]; then
  echo "请先按 docs/factory-mvp.md 安装 Gemini 网关。" >&2
  exit 1
fi
"$FACTORY_ROOT/.local/gemini-venv/bin/python" "$FACTORY_ROOT/scripts/patch-gemini.py" "$FACTORY_GATEWAY/gemini_web2api.py"
"$FACTORY_ROOT/.local/gemini-venv/bin/python" - "$FACTORY_GATEWAY/config.json" "$FACTORY_ROOT/.local-data/gemini-throttle.json" <<'PYCONFIG'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
config = json.loads(path.read_text())
config.setdefault('request_interval_sec', 30)
config.setdefault('failure_cooldown_sec', 120)
config.setdefault('throttle_state_file', sys.argv[2])
path.write_text(json.dumps(config, indent=2))
path.chmod(0o600)
PYCONFIG
cd "$FACTORY_GATEWAY"
exec "$FACTORY_ROOT/.local/gemini-venv/bin/python" gemini_web2api.py
