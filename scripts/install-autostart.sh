#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
project_dir="$PWD"
mkdir -p /start.d "$project_dir/logs"
python3 - "$project_dir" <<'PY'
import shlex
import sys
from pathlib import Path
root = Path(sys.argv[1])
script = Path('/start.d/90-gpu-image-service.sh')
script.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' +
                  'nohup bash ' + shlex.quote(str(root / 'scripts/start.sh')) +
                  ' >> ' + shlex.quote(str(root / 'logs/service.log')) + ' 2>&1 </dev/null &\n')
script.chmod(0o755)
print('Installed:', script)
PY
echo 'Autostart configured for CompShare containers; service was not started by this script.'
