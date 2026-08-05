#!/bin/zsh
set -euo pipefail

bridge_directory="${0:A:h}"
node_binary="$(command -v node)"
launch_agents_directory="$HOME/Library/LaunchAgents"
plist_file="$launch_agents_directory/be.geert.soundtouch-preset-bridge.plist"
log_directory="$HOME/Library/Logs/SoundTouchPresetBridge"

mkdir -p "$launch_agents_directory" "$log_directory"

/usr/bin/sed \
  -e "s|__NODE__|$node_binary|g" \
  -e "s|__BRIDGE__|$bridge_directory/bridge.mjs|g" \
  -e "s|__WORKDIR__|$bridge_directory|g" \
  -e "s|__LOGDIR__|$log_directory|g" \
  "$bridge_directory/macos-launch-agent.plist.template" > "$plist_file"

/bin/launchctl bootout "gui/$(id -u)/be.geert.soundtouch-preset-bridge" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$(id -u)" "$plist_file"
/bin/launchctl kickstart -k "gui/$(id -u)/be.geert.soundtouch-preset-bridge"

echo "SoundTouch bridge is geïnstalleerd en gestart."
echo "Log: $log_directory/bridge.log"
