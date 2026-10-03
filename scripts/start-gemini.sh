#!/usr/bin/env bash
set -euo pipefail
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_GATEWAY="$FACTORY_ROOT/.local/gemini-web2api"
if [[ ! -f "$FACTORY_GATEWAY/gemini_web2api.py" ]]; then
  echo "请先按 docs/factory-mvp.md 安装 Gemini 网关。" >&2
  exit 1
fi
"$FACTORY_ROOT/.local/gemini-venv/bin/python" "$FACTORY_ROOT/scripts/patch-gemini.py" "$FACTORY_GATEWAY/gemini_web2api.py"
cd "$FACTORY_GATEWAY"
exec "$FACTORY_ROOT/.local/gemini-venv/bin/python" gemini_web2api.py
