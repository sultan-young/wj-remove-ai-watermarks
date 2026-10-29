#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/use-node.sh"
if [[ ! -x ./node_modules/.bin/pm2 ]]; then
  echo 'pm2 is not installed. Run npm ci.' >&2
  exit 1
fi
exec ./node_modules/.bin/pm2 logs gpu-image-service --lines "${1:-100}"
