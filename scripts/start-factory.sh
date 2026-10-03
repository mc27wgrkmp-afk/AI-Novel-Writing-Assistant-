#!/usr/bin/env bash
set -euo pipefail
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_LOCAL_NODE="$FACTORY_ROOT/.local/runtime/node-v22.12.0-darwin-arm64/bin/node"
if [[ -x "${FACTORY_NODE_BIN:-$FACTORY_LOCAL_NODE}" ]]; then
  FACTORY_NODE_BIN="${FACTORY_NODE_BIN:-$FACTORY_LOCAL_NODE}"
elif command -v node >/dev/null 2>&1; then
  FACTORY_NODE_BIN="$(command -v node)"
else
  echo "请先安装 Node.js 22.12 或更新的受支持版本。" >&2
  exit 1
fi
export FACTORY_NODE_BIN
export PATH="$(dirname "$FACTORY_NODE_BIN"):$PATH"
cd "$FACTORY_ROOT"
exec "$FACTORY_NODE_BIN" scripts/dev-factory.cjs
