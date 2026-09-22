#!/usr/bin/env bash
#
# uninstall-watcher.sh — stop the watcher and remove it from login.
#
set -euo pipefail
LABEL="com.presolv360.videowatcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "Watcher stopped and removed from login items."
echo "Your videos, jobs and scripts are untouched."
