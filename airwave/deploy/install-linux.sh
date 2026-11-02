#!/bin/sh
# Installs Airwave as a service that starts on boot (Raspberry Pi OS, Debian, Ubuntu).
# Usage: sh deploy/install-linux.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Install it first:  sudo apt install -y nodejs npm"
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $("$NODE" -v))."
  exit 1
fi
cd "$DIR"
npm ci --omit=dev
USER_NAME="$(id -un)"
sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" -e "s|__USER__|$USER_NAME|g" deploy/airwave.service | sudo tee /etc/systemd/system/airwave.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now airwave
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Airwave is running and will start automatically on boot."
echo "Open on your phone:  http://${IP:-<this-computer-ip>}:8095"
echo "Logs:  journalctl -u airwave -f"
