# Source from another bash script. Selects the Node version in .nvmrc.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'Source scripts/use-node.sh from the startup script.' >&2
  exit 1
fi

_node_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
_node_expected=$(tr -d '[:space:]' < "$_node_root/.nvmrc")
if [[ ! "$_node_expected" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid .nvmrc version: $_node_expected" >&2
  return 1
fi

# nvm.sh reads unset variables and may exit non-zero when .nvmrc is not installed yet.
# Relax nounset/errexit only while it loads; install happens below.
set +eu
if ! declare -F nvm >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
fi
set -e
if ! declare -F nvm >/dev/null 2>&1; then
  set -u
  echo 'nvm is installed in this environment but was not found. Set NVM_DIR to the directory that contains nvm.sh.' >&2
  return 1
fi

if ! nvm use "$_node_expected" >/dev/null 2>&1; then
  echo "Installing Node $_node_expected from .nvmrc" >&2
  nvm install "$_node_expected"
  nvm use "$_node_expected"
fi
set -u
hash -r

_node_actual=$(node -p 'process.versions.node')
if [[ "$_node_actual" != "$_node_expected" ]]; then
  echo "Node $_node_actual is active; .nvmrc requires $_node_expected" >&2
  return 1
fi
unset _node_root _node_expected _node_actual
