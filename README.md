# SoundTouch Preset Bridge

The macOS bridge listens for physical SoundTouch preset-button events over the Bose WebSocket and starts the configured stream through UPnP AVTransport. It does not use the Bose cloud or inspect network traffic.

## Requirements

- macOS with Node.js 22 or later available in `PATH`.
- A Bose SoundTouch speaker and the Mac on the same local network.
- Direct `http://` MP3 or AAC stream URLs. Older SoundTouch firmware may not support HTTPS streams.

## Configure

```sh
cd bridge
cp config.example.json config.json
```

Edit `config.json` to define up to six presets. `speakerHost` is optional. When it is `null`, the iOS app sends its Bonjour-discovered speaker address to `POST /speaker` when the app opens. A fixed address remains supported as a fallback.

`autoRecover` checks the current playback state and restarts only a stream previously started by the bridge. It does not resume standby, AirPlay, AUX, or manually paused playback.

## Run and validate

```sh
npm run check
npm start
node bridge.mjs --play 1
```

`GET /health` is available on port `8787` by default. The bridge advertises itself as `_soundtouchbridge._tcp` through Bonjour so the iOS app can find it.

## Install as a macOS service

```sh
chmod +x install-macos.sh uninstall-macos.sh run.command
./install-macos.sh
```

The LaunchAgent starts at login and restarts after a failure. Logs are stored in `~/Library/Logs/SoundTouchPresetBridge/`. Run `./uninstall-macos.sh` to remove it.

## Operational notes

- Keep the Mac awake for physical-button handling.
- One bridge process controls one speaker.
- After a speaker or router reboot, open the iOS app once if no fixed `speakerHost` is configured.
- A physical preset must contain a non-empty Bose preset entry for the firmware to emit the selection event.
