# Sky Lite Remote

A no-install web app that controls BlissLights Sky Lite / Sky Lite Evolve galaxy projectors over Bluetooth.
It is plain HTML/JS with no build step and no dependencies, and it works offline once loaded.

| Platform | How |
|---|---|
| Android | Chrome or Edge. You can add it to the home screen ("Install app") |
| Windows / Mac / Linux / ChromeOS | Chrome or Edge |
| iPhone / iPad (iOS 26.2+) | Safari with the free [beacio](https://apps.apple.com/app/id6761301368) extension (formerly "WebBLE"), allowed on the site |
| Older iPhone / iPad | The free [Bluefy](https://apps.apple.com/app/id1492822055) browser |

iPhone visitors get guided automatically (`js/platform.js`):
- **Chrome, Firefox or Edge on iOS:** an "Open in Safari" button (`x-safari-https://…`, undocumented but works on most iOS versions) plus a "Copy link" fallback.
- **Safari without beacio:** install and enable steps.
- **beacio installed but not allowed on the site:** how to allow it.
- **Opened from a Home Screen icon:** extensions don't run there, so it points back to Safari.

## Try it locally

```
cd web
python -m http.server 8765
```

Open http://localhost:8765 in Chrome. Web Bluetooth needs `localhost` or HTTPS.

## Publish (GitHub Pages)

Live at https://feltocraig.github.io/BlissLights/.
`.github/workflows/pages.yml` publishes this folder whenever `web/**` changes on `main` (Settings → Pages → Source: GitHub Actions).
The APK, `decompiled/` and firmware are git-ignored. They're the original company's copyrighted code, so never commit them.

When you change files, bump `VERSION` in `sw.js` so installed copies update.

## How connecting works

1. You pick the projector in the browser's Bluetooth dialog.
2. The app logs in with the projector's mesh name (its Bluetooth name) and the password `123`.
3. Telink encryption also needs part of the projector's MAC address, and browsers hide it. The app recovers it from the projector's first encrypted status message.
   It brute-forces 16.7M possibilities in a Web Worker, which takes a few seconds once. A final address byte is then confirmed by asking the projector.
   The result is saved, so later connections are instant.
   As a fallback, you can type the MAC under *Connection settings*. Get it from `poc/blisslight.py scan` or a BLE scanner app such as nRF Connect.

## Tests

* `node tests/crypto.test.mjs` checks the browser crypto against the Python reference (needs the repo's `.venv`).
* `tests/fake-bluetooth.js` is a simulated projector for testing the whole UI without hardware. In the page's console:
  `const f = await import('./tests/fake-bluetooth.js'); f.install({ mac: 'D0:3E:7D:5E:9F:21' })`, then click Connect.

Protocol details: `../PROTOCOL.md`.
