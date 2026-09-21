#!/usr/bin/env bash
# Recorta journald y deja tope para que /var/log no crezca. La app ya recorta
# server.log / PM2 sola. Esto es solo el sistema (hace falta sudo).
set -euo pipefail
sudo journalctl --vacuum-time=7d --vacuum-size=40M || true
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=40M
MaxRetentionSec=7day
EOF
sudo systemctl restart systemd-journald || true
echo "journal:"
sudo journalctl --disk-usage || true
