#!/usr/bin/env bash
# Optional: fresh environment only. Existing raiw-test venv should be reused.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 -c 'import torch; assert torch.cuda.is_available(), "Select a CUDA-enabled PyTorch base image first"; print(torch.__version__)'
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install -r python/requirements.txt
echo 'Set PYTHON_BIN to the absolute path of .venv/bin/python in .env.'
