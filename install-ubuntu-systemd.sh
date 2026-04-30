#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-gateway}"
INSTALL_DIR="${INSTALL_DIR:-/opt/gateway}"
ENV_FILE="${ENV_FILE:-/etc/gateway.env}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"
RUN_GROUP="${RUN_GROUP:-$RUN_USER}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SOURCE_SCRIPT="${SCRIPT_DIR}/reclaude-cliproxy-gateway.mjs"
TARGET_SCRIPT="${INSTALL_DIR}/reclaude-cliproxy-gateway.mjs"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node was not found. Install Node.js 20+ first." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_SCRIPT" ]]; then
  echo "Run this script from the directory containing reclaude-cliproxy-gateway.mjs." >&2
  exit 1
fi

sudo install -d -o "$RUN_USER" -g "$RUN_GROUP" "$INSTALL_DIR"

if [[ "$(readlink -f "$SOURCE_SCRIPT")" != "$(readlink -f "$TARGET_SCRIPT" 2>/dev/null || true)" ]]; then
  sudo install -m 0755 -o "$RUN_USER" -g "$RUN_GROUP" "$SOURCE_SCRIPT" "$TARGET_SCRIPT"
else
  sudo chown "$RUN_USER:$RUN_GROUP" "$TARGET_SCRIPT"
  sudo chmod 0755 "$TARGET_SCRIPT"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  sudo install -m 0640 -o root -g "$RUN_GROUP" "${SCRIPT_DIR}/reclaude-cliproxy-gateway.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Edit it before starting the service if your user or ports differ."
fi

sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<SERVICE
[Unit]
Description=Local Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${TARGET_SCRIPT}
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}.service"
sudo systemctl restart "${SERVICE_NAME}.service"

echo "Installed ${SERVICE_NAME}.service"
echo "Environment: ${ENV_FILE}"
echo "Status: sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "Health: curl http://127.0.0.1:58400/__health"
