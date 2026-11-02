#!/bin/sh
# Runs Airwave in the background on a Mac and starts it at login.
# Usage: sh deploy/install-mac.sh      (undo: launchctl unload ~/Library/LaunchAgents/com.airwave.hub.plist)
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS) and run this again."
  exit 1
fi
cd "$DIR"
npm ci --omit=dev
PLIST="$HOME/Library/LaunchAgents/com.airwave.hub.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.airwave.hub</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>8095</string><key>DATA_DIR</key><string>$DIR/data</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/airwave.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/airwave.log</string>
</dict></plist>
PL
mkdir -p "$DIR/data"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<this-mac-ip>')"
echo
echo "Airwave is running and starts automatically when you log in."
echo "Open on your phone:  http://$IP:8095"
echo "Tip: in System Settings > Energy, prevent automatic sleep so alarms and preset buttons keep working."
