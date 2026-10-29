#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/use-node.sh"
npm ci
npm run build
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
fi
node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const p=".env"; let t=fs.readFileSync(p,"utf8"); const m=t.match(/^API_KEY=(.*)$/m); const v=m?m[1].trim():""; if (v.length>=24 && !v.startsWith("replace-this-")) process.exit(0); const key=crypto.randomBytes(32).toString("hex"); t=m?t.replace(/^API_KEY=.*$/m,"API_KEY="+key):"API_KEY="+key+"\n"+t; fs.writeFileSync(p,t); console.log("Wrote API_KEY into .env")'
echo 'Node service installed. Edit .env to point PYTHON_BIN/HF_HOME at your existing environment.'
echo 'Existing Torch, Python dependencies and model cache were not changed.'
