# BlissLights Sky Lite / Sky Lite Evolve BLE protocol

Reverse engineered from `Blisslights_3.3.67_APKPure.apk` (package `com.quhwa.mesh`, made by Quhwa).
Decompiled sources are in `decompiled/sources`. The file and class references below point there.

## TL;DR

* The projector is a **Telink proprietary BLE mesh** device. This is the older pre-SIG "Telink SmartLight" mesh, the same family used by AwoX, Sengled and many cheap Chinese lights. It is **not** Bluetooth SIG Mesh.
* No cloud is needed. All control is local BLE. The app's server (`tilvision.net`) only handled accounts and sharing.
* Credentials are **mesh name + password**. Password is always `123` (`Constant.MESH_PASSWORD`).
  The mesh name was a random 12-hex-char string the app generated per phone (`QuhwaMeshApplication.getMesh`).
  **The device advertises its mesh name as its BLE local name**, so you can recover it by scanning.
* All projector features use one vendor opcode, `0xF0`, with a 10-byte payload whose first byte is a sub-command.

## GATT

| UUID | Purpose |
|---|---|
| `00010203-0405-0607-0809-0a0b0c0d1910` | Telink service |
| `...1914` | Pair / login (write, then read) |
| `...1912` | Command (write without response) |
| `...1911` | Notify (subscribe, then write `01` to it) |
| `...1913` | OTA firmware |

## Advertising

* AD type `0x09` (complete local name) holds the **mesh name**. It is up to 16 bytes and is zero-padded when used as a key.
* The second manufacturer-data record has company ID `0x0211` (Telink). The bytes after the company ID are:
  `[0-1] mesh UUID, [2-5] low 4 bytes of the reversed MAC, [6-7] product UUID, [8] status, [9-10] mesh address (LE)`
  (`DefaultAdvertiseDataFilter`).

## Login / session key (`LightController.login`, `getSessionKey`)

All AES is AES-128-ECB with **byte-reversed** key and input (`AES.encrypt`). `aes_att` also reverses the output.

```
np        = pad16(name) XOR pad16(password)
r_app     = 8 random bytes
write PAIR: 0x0C | r_app | reverse( AES.encrypt(r_app‖0*8, np)[8:16] )
read  PAIR: 0x0D | r_dev(8) | proof(8)          (0x0E = wrong name/password)
check:      proof == reverse( AES.encrypt(r_dev‖0*8, np)[8:16] )
sessionKey = reverse( AES.encrypt(np, r_app ‖ r_dev) )
```

## Command packet (20 bytes, then encrypted)

```
[0-2] sequence number (LE, increment every packet)
[3-4] 00 00              (overwritten with MIC)
[5-6] destination mesh address (LE)   (0xFFFF = all)
[7]   opcode | 0xC0       (0xF0 → 0xF0)
[8-9] vendor id 0x0211    (11 02)
[10-19] params (10 bytes, zero padded)
```

Encryption is in `AES.encrypt(key, nonce, data)`. The nonce is `mac[0..3] | 0x01 | seq[0..2]`, where `mac` is the BLE MAC with its bytes reversed.
(jadx shows this function in the wrong order. The real order comes from the raw bytecode.)
Notifications are decrypted with nonce `mac[0..2] | notify[0..4]`.
Decrypted notifications look like `[0-2] seq, [3-4] source addr, [5-6] MIC, [7] opcode (0xEA/0xEB), [8-9] vendor, [10-19] params`.
The full working implementation is in `poc/telink_crypto.py`. It has been checked byte-for-byte against the app's Java code.

## Sky Lite vendor sub-commands (opcode `0xF0`), from `Fra_MainHome.java`

| Payload | Meaning |
|---|---|
| `41 <id> 00` | Play effect. Ids: 1 Stars against nebula, 2 Fading, 3 Stars, 4 Nebula, 5 Ocean, 6 Space, 8 Sunrise, 9 RGB auto, 10-19 DIY |
| `41 00 01` | Turn off |
| `42 <ff/00>` | Rotation motor on/off |
| `43 <1/2/3>` | Brightness low/medium/high |
| `47 R G B laser motor bright fade` | Manual control. The app only sends 0 or 255 for R/G/B/laser/motor. fade is 0/1 |
| `48` | Query manual state. The reply is `48 R G B laser motor bright fade` |
| `44 FF` | Query config. The reply is `44 FF motor bright onTime offTime defaultScene lastScene loopTime isLoop` |
| `40 FF motor bright onTime offTime defaultScene lastScene loopTime isLoop` | Write config (timer and effect cycling). The app's loopTime options are 0, 1, 2, 3, 6, 12 |
| `44 FD` | Query device type. The reply is `44 FD <type>`: 3 = RGB + laser (Evolve), 4 = RGB without laser, 5 = BlissGlow strip, other = original blue Sky Lite |
| `44 FB` | Query firmware. The reply is `44 FB <7 ASCII bytes>`, e.g. `v001.13` |
| `44 <10-19>` | Query a DIY slot. The reply is `44 id enabled R G B L M fade` |
| `45 <1/0> R G B L M fade` | Enter/exit DIY edit mode (live preview) |
| `40 <10-19> 01 R G B L M fade 00` | Save a DIY slot. `40 <id> 00` deletes it |
| `50 <pkt 0..2> id×8` | Set the effect-cycle playlist, 8 ids per packet |
| `49 ...` | Unsolicited "current effect changed" report: `49 addrLo addrHi effectId ... loopTime` |

The BlissGlow LED strip (device type 5) uses a different command set (`0x11`–`0x1C`). It is in `lightstrip/StripCmdManager.java`.

## If login fails

* Hold the power button until the projector flashes **6 times**. This is the app's own "activate Bluetooth / reset" instruction (`reset_msg`).
* After a factory reset the mesh name should go back to a Telink factory default (`telink_mesh1`, or `telink_mesh0` in this app's config), with password `123`. The scan will show the new name either way.

## Firmware

`decompiled/resources/assets/four*.bin` are OTA firmware images (e.g. `four-v001.13.bin`). Keep them. The app warns when firmware is older than v001.13.

## Browsers and the MAC address

Web Bluetooth doesn't expose MAC addresses, but the nonces need `mac[0..3]`. `web/js/macsearch.js` recovers `mac[0..2]` by brute force. It tries all 2^24 values against one encrypted notification, and the right one decrypts to vendor `0x0211` and passes the MIC.
`mac[3]` is then found by binary search over query packets: only a packet built with the right byte gets a reply.
