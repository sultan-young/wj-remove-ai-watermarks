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

# Hold the lock inside the daemon so it lasts until Node exits. Parent returns after start.
(
  flock -n 9 || exit 75
  printf '%s\n' $$ > .service.pid
  exec node dist/main.js
) 9>.service.lock >>logs/service.log 2>&1 &
pid=$!

# Catch "already running" or an immediate crash (missing sharp, bad .env, etc.).
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  set +e
  wait "$pid"
  code=$?
  set -e
  if [[ "$code" -eq 75 ]]; then
    echo 'This project already has a running service' >&2
    exit 75
  fi
  echo 'Service failed to start; see logs/service.log' >&2
  exit 1
fi

echo "Started in background (pid $pid). Logs: logs/service.log"
