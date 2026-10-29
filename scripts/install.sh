#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw Error("Install Node.js 24 LTS first")'
npm ci
npm run build
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; const p=".env"; fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^API_KEY=.*$/m,"API_KEY="+crypto.randomBytes(32).toString("hex")))'
fi
echo 'Node service installed. Edit .env to point PYTHON_BIN/HF_HOME at your existing environment.'
echo 'Existing Torch, Python dependencies and model cache were not changed.'
