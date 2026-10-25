# Sky Lite Remote

A community replacement for the discontinued BlissLights app. It controls Sky Lite / Sky Lite Evolve galaxy projectors over Bluetooth, straight from a web page with nothing to install.

**Open the app: https://feltocraig.github.io/BlissLights/**

| Platform | How |
|---|---|
| Android, Windows, Mac, Linux, ChromeOS | Chrome or Edge |
| iPhone / iPad (iOS 26.2+) | Safari with the free [beacio](https://apps.apple.com/app/id6761301368) extension |
| Older iPhone / iPad | The free [Bluefy](https://apps.apple.com/app/id1492822055) browser |

Turn the projector on, open the link, tap **Connect to projector** and pick it from the list. If it doesn't show up, hold the power button until it flashes 6 times and try again.

Independent and community-made. Not affiliated with BlissLights. Everything runs locally over Bluetooth and no data leaves your device.

## What's here

| Path | What |
|---|---|
| `web/` | The web app (plain HTML/JS, no build step). This folder is what gets published to GitHub Pages. See [`web/README.md`](web/README.md) |
| `PROTOCOL.md` | The projector's Bluetooth protocol (Telink BLE mesh) |
| `poc/` | Python command-line controller (`pip install bleak cryptography`, then `python poc/blisslight.py scan`) |

Pushing changes under `web/` to `main` redeploys the site automatically (`.github/workflows/pages.yml`). Bump `VERSION` in `web/sw.js` when you change files so installed copies update.
