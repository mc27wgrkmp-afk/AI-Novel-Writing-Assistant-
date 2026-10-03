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
config['request_interval_sec'] = max(120, float(config.get('request_interval_sec', 120)))
config['failure_cooldown_sec'] = max(900, float(config.get('failure_cooldown_sec', 900)))
config['retry_attempts'] = 1
config.setdefault('throttle_state_file', sys.argv[2])
path.write_text(json.dumps(config, indent=2))
path.chmod(0o600)
PYCONFIG
cd "$FACTORY_GATEWAY"
FACTORY_ENGINE="${GEMINI_GATEWAY_ENGINE:-$("$FACTORY_ROOT/.local/gemini-venv/bin/python" -c 'import json; print(json.load(open("config.json")).get("gateway_engine", "legacy"))')}"
if [[ "$FACTORY_ENGINE" == "hanaoka" ]]; then
  if [[ ! -x "$FACTORY_ROOT/.local/gemini-api-venv/bin/python" ]]; then
    echo "请先运行 bash scripts/setup-gemini.sh --hanaoka。" >&2
    exit 1
  fi
  exec "$FACTORY_ROOT/.local/gemini-api-venv/bin/python" "$FACTORY_ROOT/scripts/gemini-api-gateway.py"
elif [[ "$FACTORY_ENGINE" != "legacy" ]]; then
  echo "未知的 Gemini 网关引擎；可选 hanaoka 或 legacy。" >&2
  exit 1
fi
exec "$FACTORY_ROOT/.local/gemini-venv/bin/python" gemini_web2api.py
