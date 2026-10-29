#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/use-node.sh"
if [[ ! -x ./node_modules/.bin/pm2 ]]; then
  echo 'pm2 is not installed. Run npm ci.' >&2
  exit 1
fi
./node_modules/.bin/pm2 delete gpu-image-service >/dev/null 2>&1 || ./node_modules/.bin/pm2 stop gpu-image-service >/dev/null 2>&1 || true
./node_modules/.bin/pm2 save >/dev/null 2>&1 || true
echo 'Stopped gpu-image-service.'
