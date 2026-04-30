# ReClaude CLIProxy Gateway

Small Node.js gateway for routing Claude-compatible requests through a local `reclaude` daemon. It adapts `metadata.user_id` into the Claude Code shape required by reclaude.

## Requirements

- Ubuntu 22.04+ or similar systemd Linux server.
- Node.js 20+.
- `reclaude` installed, logged in, and daemon running on the same server.
- Claude Code logged in on the same Linux user.

The service needs these files from the same user:

```text
~/.reclaude/state.json
~/.reclaude/ca.pem
~/.reclaude/device.json
~/.claude/.credentials.json
~/.claude.json
```

`~/.claude.json` is required because reclaude rejects requests whose Claude Code `device_id/account_uuid/session_id` metadata does not match local state.

## Install On Ubuntu

Copy this directory to the server, then run:

```bash
chmod +x install-ubuntu-systemd.sh
RUN_USER=ubuntu ./install-ubuntu-systemd.sh
```

Edit the environment file if your server user is not `ubuntu` or the daemon port differs:

```bash
sudo editor /etc/reclaude-cliproxy-gateway.env
```

Start or restart:

```bash
sudo systemctl restart reclaude-cliproxy-gateway
sudo systemctl status reclaude-cliproxy-gateway --no-pager
```

Enable on boot is handled by the installer:

```bash
sudo systemctl enable reclaude-cliproxy-gateway
```

Check health:

```bash
curl http://127.0.0.1:58400/__health
```

View logs:

```bash
journalctl -u reclaude-cliproxy-gateway -f
```

## CLIProxy/NewAPI

Point CLIProxy's Claude upstream `base-url` at this gateway:

```yaml
claude-api-key:
  - api-key: reclaude-local
    base-url: http://127.0.0.1:58400
```

If CLIProxy runs inside Docker on the same server, either use host networking or expose the gateway on a private interface and configure Docker host access. Do not expose this gateway publicly without firewall rules or another authentication layer.

## Runtime Behavior

Configured in `/etc/reclaude-cliproxy-gateway.env`:

```text
RECLAUDE_ACCESS_LOG=true
```

Current support:

```text
Non-streaming messages: yes
SSE streaming responses: yes
Concurrent requests: yes
WebSocket: no
```
