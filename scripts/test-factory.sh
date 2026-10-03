#!/usr/bin/env bash
set -euo pipefail
FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_LOCAL_NODE="$FACTORY_ROOT/.local/runtime/node-v22.12.0-darwin-arm64/bin/node"
if [[ -x "${FACTORY_NODE_BIN:-$FACTORY_LOCAL_NODE}" ]]; then
  export PATH="$(dirname "${FACTORY_NODE_BIN:-$FACTORY_LOCAL_NODE}"):$PATH"
fi
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
cd "$FACTORY_ROOT"
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/server build
node --test server/tests/factoryMvp.test.js
