#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p deployment-lock
npm ls --json > deployment-lock/node-packages.json
node --input-type=module <<'JS'
import 'dotenv/config';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const python = process.env.PYTHON_BIN || 'python3';
for (const [name,args] of [['python-freeze.txt',['-m','pip','freeze']],['gpu.txt',['-c',
 'import torch; print("Torch:",torch.__version__); print("CUDA:",torch.version.cuda); print("Available:",torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none")']]]) {
 const result=spawnSync(python,args,{encoding:'utf8'});
 if(result.status!==0) throw Error(result.stderr);
 fs.writeFileSync('deployment-lock/'+name,result.stdout);
}
JS
echo 'Exported actual deployment dependencies. Keep these with the tested private image; do not publish secrets.'
