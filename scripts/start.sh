#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ ! -f .env ]]; then
  echo 'Missing .env. Copy .env.example and configure API_KEY, PYTHON_BIN and HF_HOME.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw Error("Node.js 24 required")'
if [[ ! -f dist/main.js ]]; then
  echo 'Missing dist/main.js. Run npm ci && npm run build first.' >&2
  exit 1
fi
mkdir -p logs
command -v flock >/dev/null || { echo 'Install util-linux (flock)' >&2; exit 1; }
exec 9>.service.lock
flock -n 9 || { echo 'This project already has a running service' >&2; exit 75; }
exec node dist/main.js
