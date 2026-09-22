#!/usr/bin/env bash
#
# install-watcher.sh — run this ONCE. After it, nobody touches a terminal again.
#
# Installs watch-jobs.sh as a macOS LaunchAgent so it starts at login and
# restarts itself if it ever dies. From then on, Claude can produce videos from
# chat: it writes a job into "Video Automation/_jobs/", the watcher runs it.
#
#   ./watcher/install-watcher.sh
#
# To stop it later:  ./watcher/uninstall-watcher.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.presolv360.videowatcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/presolv360-video"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
chmod +x "$HERE/watch-jobs.sh" "$HERE/../"*.sh 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/watch-jobs.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/watcher.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/watcher.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>VIDEO_ROOT</key><string>$HOME/Desktop/Video Automation</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load  "$PLIST"

sleep 2
if launchctl list | grep -q "$LABEL"; then
  cat <<EOF

Watcher installed and running.

  jobs folder   ~/Desktop/Video Automation/_jobs/
  logs          $LOGDIR/watcher.log

It starts automatically at login from now on. Nothing else to do — tell Claude
your topic and hook in chat and it will take it from there.

One thing to know: the automation Chrome window will open while a video is
being made, and the Mac needs to stay awake. The watcher handles both.
EOF
else
  echo "The LaunchAgent did not start. Check $LOGDIR/watcher.err" >&2
  exit 1
fi
