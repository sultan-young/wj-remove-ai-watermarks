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
if [[ ! -x ./node_modules/.bin/pm2 ]]; then
  echo 'pm2 is not installed. Run npm ci.' >&2
  exit 1
fi
mkdir -p logs

PM2=(./node_modules/.bin/pm2)
export GPU_IMAGE_NODE
GPU_IMAGE_NODE="$(command -v node)"
APP_NAME=gpu-image-service
timeout_s=$(grep -E '^WORKER_START_TIMEOUT_SECONDS=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true)
export WORKER_START_TIMEOUT_SECONDS="${timeout_s:-600}"

echo "Using Node $GPU_IMAGE_NODE"
"${PM2[@]}" delete "$APP_NAME" >/dev/null 2>&1 || true

# Cleanup leftover processes from the pre-PM2 start.sh (flock / wrong .service.pid).
if [[ -f .service.pid ]]; then
  old=$(tr -d '[:space:]' < .service.pid || true)
  if [[ "$old" =~ ^[0-9]+$ ]] && kill -0 "$old" 2>/dev/null; then
    echo "Stopping legacy non-PM2 process (pid $old)…"
    kill "$old" 2>/dev/null || true
    sleep 1
    kill -9 "$old" 2>/dev/null || true
  fi
  rm -f .service.pid
fi
if command -v pgrep >/dev/null 2>&1; then
  while read -r p; do
    [[ "$p" =~ ^[0-9]+$ ]] || continue
    cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
    if [[ "$cwd" == "$PWD" ]]; then
      echo "Stopping leftover node process in this directory (pid $p)…"
      kill "$p" 2>/dev/null || true
      sleep 0.5
      kill -9 "$p" 2>/dev/null || true
    fi
  done < <(pgrep -f 'node dist/main.js' || true)
fi
rm -f .service.lock

echo "Starting $APP_NAME with PM2…"
if ! "${PM2[@]}" start ecosystem.config.cjs --update-env; then
  echo 'PM2 failed to start the app; see: npm run logs' >&2
  exit 1
fi

echo "HTTP process started. Streaming logs until /health/ready (timeout ${WORKER_START_TIMEOUT_SECONDS}s)…"
"${PM2[@]}" logs "$APP_NAME" --raw --lines 0 &
logs_pid=$!
cleanup_logs() { kill "$logs_pid" 2>/dev/null || true; wait "$logs_pid" 2>/dev/null || true; }
trap cleanup_logs EXIT

set +e
node --input-type=module <<'JS'
import 'dotenv/config';

const port = process.env.PORT || '8000';
const key = process.env.API_KEY;
const timeoutMs = Math.max(1, Number(process.env.WORKER_START_TIMEOUT_SECONDS || 600)) * 1000;
const deadline = Date.now() + timeoutMs;
if (!key) {
  console.error('API_KEY missing from .env');
  process.exit(1);
}

while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.ok) process.exit(0);
  } catch {
    // not listening / not ready yet
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
process.exit(3);
JS
wait_code=$?
set -e
cleanup_logs
trap - EXIT

if [[ "$wait_code" -ne 0 ]]; then
  echo "Workers did not become ready in time; see: npm run logs" >&2
  "${PM2[@]}" logs "$APP_NAME" --lines 80 --nostream || true
  "${PM2[@]}" delete "$APP_NAME" >/dev/null 2>&1 || true
  exit 1
fi

status="$("${PM2[@]}" jlist)"
if ! printf '%s' "$status" | node --input-type=module -e '
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const apps = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
const app = apps.find((item) => item.name === "gpu-image-service");
if (!app || app.pm2_env?.status !== "online") {
  console.error(`PM2 app is not online (status=${app?.pm2_env?.status ?? "missing"})`);
  process.exit(1);
}
'; then
  echo 'Startup did not keep the app online; see: npm run logs' >&2
  exit 1
fi

"${PM2[@]}" save >/dev/null 2>&1 || true
echo
"${PM2[@]}" status "$APP_NAME"
echo
echo "Started. Logs: npm run logs   Stop: npm run stop   Restart: npm run start"
