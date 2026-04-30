# Local Gateway

Small Node.js gateway for routing API-compatible requests through a local upstream service. It performs a lightweight request adaptation step before forwarding.

## Requirements

- Ubuntu 22.04+ or similar systemd Linux server.
- Node.js 20+.
- Required upstream credentials and state files must already exist for the same Linux user that will run this service.
- A local upstream service must already be installed, authenticated, and running on the same server.

## Install Or Update On Ubuntu

First-time checkout:

```bash
sudo git clone git@github.com:wanbiao1993usa/gateway.git /opt/gateway
sudo chown -R ubuntu:ubuntu /opt/gateway
```

Deploy or update:

```bash
cd /opt/gateway
git pull --ff-only
bash deploy.sh
```

The deploy script installs or updates the systemd service, enables it on boot, and restarts it.

Edit the generated environment file if the user paths or local upstream port differ:

```bash
sudo editor /etc/gateway.env
```

Check service status:

```bash
sudo systemctl status gateway --no-pager
```

Enable on boot is handled by the installer:

```bash
sudo systemctl enable gateway
```

Check health:

```bash
curl http://127.0.0.1:58400/__health
```

View logs:

```bash
journalctl -u gateway -f
```

## Client Configuration

Point your client or proxy base URL at this gateway:

```text
http://127.0.0.1:58400
```

If the caller runs inside Docker on the same server, either use host networking or expose the gateway on a private interface and configure Docker host access. Do not expose this gateway publicly without firewall rules or another authentication layer.

## Runtime Behavior

Current support:

```text
Non-streaming requests: yes
Streaming responses: yes
Concurrent requests: yes
WebSocket: no
```
