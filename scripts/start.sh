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

# Hold the lock inside the daemon so it lasts until Node exits.
(
  flock -n 9 || exit 75
  printf '%s\n' $$ > .service.pid
  if command -v stdbuf >/dev/null; then
    exec stdbuf -oL -eL node dist/main.js
  fi
  exec node dist/main.js
) 9>.service.lock >>logs/service.log 2>&1 &
pid=$!

# Already running or died before opening the log.
sleep 0.3
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

echo "Starting (pid $pid). Streaming logs until ready…"
# Show only new lines while we wait; keep writing to the same log file.
tail -n 0 -F logs/service.log --pid="$pid" 2>/dev/null &
tail_pid=$!
cleanup_tail() { kill "$tail_pid" 2>/dev/null || true; wait "$tail_pid" 2>/dev/null || true; }
trap cleanup_tail EXIT

set +e
node --input-type=module - "$pid" <<'JS'
import 'dotenv/config';
import { kill } from 'node:process';

const pid = Number(process.argv[2]);
const port = process.env.PORT || '8000';
const key = process.env.API_KEY;
const timeoutMs = Math.max(1, Number(process.env.WORKER_START_TIMEOUT_SECONDS || 600)) * 1000;
const deadline = Date.now() + timeoutMs;
if (!key) {
  console.error('API_KEY missing from .env');
  process.exit(1);
}

function alive() {
  try { kill(pid, 0); return true; } catch { return false; }
}

while (Date.now() < deadline) {
  if (!alive()) process.exit(2);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.ok) process.exit(0);
  } catch {
    // HTTP not listening yet
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
process.exit(3);
JS
wait_code=$?
set -e
cleanup_tail
trap - EXIT

if [[ "$wait_code" -eq 0 ]]; then
  echo "Started successfully in background (pid $pid). Logs: logs/service.log"
  exit 0
fi
if [[ "$wait_code" -eq 2 ]]; then
  echo 'Service exited before becoming ready; see logs/service.log' >&2
  exit 1
fi
if [[ "$wait_code" -eq 3 ]]; then
  echo "Timed out waiting for /health/ready; stopping pid $pid. See logs/service.log" >&2
  kill "$pid" 2>/dev/null || true
  exit 1
fi
echo 'Service failed to become ready; see logs/service.log' >&2
exit 1
