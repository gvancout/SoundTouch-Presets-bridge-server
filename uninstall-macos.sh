#!/bin/zsh
set -euo pipefail

plist_file="$HOME/Library/LaunchAgents/be.geert.soundtouch-preset-bridge.plist"
/bin/launchctl bootout "gui/$(id -u)/be.geert.soundtouch-preset-bridge" 2>/dev/null || true
/bin/rm -f "$plist_file"
echo "SoundTouch bridge is verwijderd."
