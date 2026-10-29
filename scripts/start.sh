#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/use-node.sh"
if [[ ! -f .env ]]; then
  echo 'Missing .env. Copy .env.example and configure API_KEY, PYTHON_BIN and HF_HOME.' >&2
  exit 1
fi
if [[ ! -f dist/main.js ]]; then
  echo 'Missing dist/main.js. Run npm ci && npm run build first.' >&2
  exit 1
fi
mkdir -p logs
command -v flock >/dev/null || { echo 'Install util-linux (flock)' >&2; exit 1; }
exec 9>.service.lock
flock -n 9 || { echo 'This project already has a running service' >&2; exit 75; }
exec node dist/main.js
