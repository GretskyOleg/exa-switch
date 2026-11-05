#!/usr/bin/env bash
# Run all non-browser tests. Requires Node.js 20+ and a built helper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required for tests." >&2
  exit 1
fi

if [ ! -f dist/helper/xray-switch-helper ]; then
  echo "Building helper first..."
  ./build.sh
fi

export HELPER_BIN="${HELPER_BIN:-$ROOT/dist/helper/xray-switch-helper}"
node --test tests/run-tests.mjs tests/background.test.mjs tests/helper-smoke.mjs
