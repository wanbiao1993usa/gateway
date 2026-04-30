#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export SERVICE_NAME="${SERVICE_NAME:-gateway}"
export INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
export ENV_FILE="${ENV_FILE:-/etc/gateway.env}"

"${SCRIPT_DIR}/install-ubuntu-systemd.sh"
