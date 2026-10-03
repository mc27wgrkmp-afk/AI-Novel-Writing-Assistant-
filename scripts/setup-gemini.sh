#!/usr/bin/env bash
set -euo pipefail
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_GATEWAY="$FACTORY_ROOT/.local/gemini-web2api"
FACTORY_GATEWAY_REV="2bb988bfcbb82a7fab5d2c99aa5560ff40d64f7e"
FACTORY_ENGINE="${1:-legacy}"
if [[ "$FACTORY_ENGINE" != "legacy" && "$FACTORY_ENGINE" != "--hanaoka" ]]; then
  echo "用法：bash scripts/setup-gemini.sh [--hanaoka]" >&2
  exit 1
fi
mkdir -p "$FACTORY_ROOT/.local"
if [[ ! -d "$FACTORY_GATEWAY/.git" ]]; then
  git clone --depth 1 https://github.com/Sophomoresty/gemini-web2api.git "$FACTORY_GATEWAY"
  git -C "$FACTORY_GATEWAY" fetch --depth 1 origin "$FACTORY_GATEWAY_REV"
  git -C "$FACTORY_GATEWAY" checkout --detach "$FACTORY_GATEWAY_REV"
fi
if [[ ! -x "$FACTORY_ROOT/.local/gemini-venv/bin/python" ]]; then
  python3 -m venv "$FACTORY_ROOT/.local/gemini-venv"
fi
"$FACTORY_ROOT/.local/gemini-venv/bin/python" -m pip install 'httpx==0.28.1'
if [[ ! -f "$FACTORY_GATEWAY/config.json" ]]; then
  "$FACTORY_ROOT/.local/gemini-venv/bin/python" - "$FACTORY_GATEWAY/config.json" <<'PY'
import json, sys
with open(sys.argv[1], 'w') as out:
    json.dump({'host': '127.0.0.1', 'port': 8081, 'api_keys': [], 'retry_attempts': 1, 'request_timeout_sec': 180, 'log_requests': False, 'temporary_chats': True}, out, indent=2)
PY
fi
if [[ "$FACTORY_ENGINE" == "--hanaoka" ]]; then
  FACTORY_PYTHON="${GEMINI_API_PYTHON:-python3.12}"
  "$FACTORY_PYTHON" -c 'import sys; assert sys.version_info >= (3, 11), "Gemini-API requires Python 3.11+"'
  if [[ ! -x "$FACTORY_ROOT/.local/gemini-api-venv/bin/python" ]]; then
    "$FACTORY_PYTHON" -m venv "$FACTORY_ROOT/.local/gemini-api-venv"
  fi
  "$FACTORY_ROOT/.local/gemini-api-venv/bin/python" -m pip install -r "$FACTORY_ROOT/scripts/gemini-api-requirements.txt"
  "$FACTORY_ROOT/.local/gemini-api-venv/bin/python" - "$FACTORY_GATEWAY/config.json" <<'PYENGINE'
import json, os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1])
data = path.read_bytes()
fd, name = tempfile.mkstemp(prefix='.config-before-hanaoka-', dir=path.parent)
with os.fdopen(fd, 'wb') as out:
    out.write(data)
if Path(name).read_bytes() != data:
    raise RuntimeError('Private configuration backup validation failed')
config = json.loads(data)
config['gateway_engine'] = 'hanaoka'
fd, name = tempfile.mkstemp(prefix='.config-engine-', dir=path.parent)
with os.fdopen(fd, 'w') as out:
    json.dump(config, out, indent=2)
os.replace(name, path)
PYENGINE
fi
echo "网关已准备好。运行 bash scripts/start-gemini.sh 启动。"
