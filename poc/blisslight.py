"""Control a BlissLights Sky Lite / Sky Lite Evolve over Bluetooth LE.

Protocol reverse engineered from the BlissLights Android app 3.3.67
(package com.quhwa.mesh). See ../PROTOCOL.md for the details.

Usage examples:
    python blisslight.py scan
    python blisslight.py status
    python blisslight.py effect stars-nebula
    python blisslight.py light --red 255 --green 0 --blue 255 --laser 255 --motor 255
    python blisslight.py off
    python blisslight.py raw 44fb          # send any vendor payload, print replies
"""
import argparse
import asyncio
import sys

from bleak import BleakClient, BleakScanner

import telink_crypto as tc

SERVICE = "00010203-0405-0607-0809-0a0b0c0d1910"
CHAR_NOTIFY = "00010203-0405-0607-0809-0a0b0c0d1911"
CHAR_COMMAND = "00010203-0405-0607-0809-0a0b0c0d1912"
CHAR_PAIR = "00010203-0405-0607-0809-0a0b0c0d1914"

TELINK_VENDOR_ID = 0x0211
DEFAULT_PASSWORD = "123"  # Constant.MESH_PASSWORD
OP_VENDOR = 0xF0          # every BlissLights command uses vendor opcode 0xF0
OP_TIME_SET = 0xE4

# scene_id_list / scene_name_list from res/values/arrays.xml
EFFECTS = {
    "stars-nebula": 1,  # Stars against nebula
    "fading": 2,
    "stars": 3,
    "nebula": 4,
    "ocean": 5,
    "space": 6,
    "sunrise": 8,
    "rgb-auto": 9,
}
# DIY scenes saved on the device use ids 10..19

DEVICE_TYPES = {3: "Sky Lite Evolve (RGB + laser)", 4: "RGB, no laser", 5: "BlissGlow strip"}


class BlissLight:
    def __init__(self, address, mesh_name, password=DEFAULT_PASSWORD, mesh_addr=0xFFFF):
        self.address = address
        self.mesh_name = mesh_name
        self.password = password
        self.mesh_addr = mesh_addr
        self.client = BleakClient(address)
        self.sk = None
        self.seq = 1
        self.replies = asyncio.Queue()

    async def __aenter__(self):
        await self.client.connect()
        pkt, rand = tc.make_login_packet(self.mesh_name, self.password)
        await self.client.write_gatt_char(CHAR_PAIR, pkt, response=True)
        resp = bytes(await self.client.read_gatt_char(CHAR_PAIR))
        self.sk = tc.make_session_key(self.mesh_name, self.password, rand, resp)
        await self.client.start_notify(CHAR_NOTIFY, self._on_notify)
        await self.client.write_gatt_char(CHAR_NOTIFY, b"\x01", response=True)
        return self

    async def __aexit__(self, *exc):
        await self.client.disconnect()

    def _on_notify(self, _char, data):
        plain = tc.decrypt_notify(self.sk, self.address, bytes(data))
        if plain is None:
            return
        src = plain[3] | (plain[4] << 8)
        self.replies.put_nowait((plain[7], src, plain[10:20]))

    async def send(self, opcode, params, dst=None):
        dst = self.mesh_addr if dst is None else dst
        if len(params) > 10:
            raise ValueError("params max 10 bytes")
        s = self.seq
        self.seq = (self.seq + 1) & 0xFFFFFF
        pkt = bytes([s & 0xFF, (s >> 8) & 0xFF, (s >> 16) & 0xFF, 0, 0,
                     dst & 0xFF, (dst >> 8) & 0xFF, opcode | 0xC0,
                     TELINK_VENDOR_ID & 0xFF, TELINK_VENDOR_ID >> 8]) + bytes(params).ljust(10, b"\x00")
        await self.client.write_gatt_char(CHAR_COMMAND, tc.encrypt_command(self.sk, self.address, pkt), response=False)

    async def vendor(self, payload, wait_for=None, timeout=3.0):
        """Send a 0xF0 vendor payload; optionally wait for a reply whose first byte(s) match."""
        while not self.replies.empty():
            self.replies.get_nowait()
        await self.send(OP_VENDOR, payload)
        if wait_for is None:
            return None
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while (left := end - loop.time()) > 0:
            try:
                _op, _src, params = await asyncio.wait_for(self.replies.get(), left)
            except asyncio.TimeoutError:
                break
            if params[:len(wait_for)] == bytes(wait_for):
                return params
        return None

    # ---- projector commands (Fra_MainHome.java) ----
    async def off(self):
        return await self.vendor([0x41, 0x00, 0x01], wait_for=[0x41])

    async def effect(self, effect_id):
        return await self.vendor([0x41, effect_id, 0x00], wait_for=[0x41])

    async def rotation(self, on):
        return await self.vendor([0x42, 0xFF if on else 0x00], wait_for=[0x42])

    async def brightness(self, level):  # 1=low 2=medium 3=high
        return await self.vendor([0x43, level], wait_for=[0x43])

    async def set_light(self, r, g, b, laser, motor, bright, fade):
        """0x47 manual control: nebula RGB, laser stars, rotation motor, brightness, fading."""
        return await self.vendor([0x47, r, g, b, laser, motor, bright, fade], wait_for=[0x47])

    async def query_light(self):
        p = await self.vendor([0x48], wait_for=[0x48])
        if p:
            return dict(red=p[1], green=p[2], blue=p[3], laser=p[4], motor=p[5], brightness=p[6], fade=p[7])

    async def query_config(self):
        p = await self.vendor([0x44, 0xFF], wait_for=[0x44, 0xFF])
        if p:
            return dict(motor=p[2], brightness=p[3], on_time=p[4], off_time=p[5],
                        default_scene=p[6], last_scene=p[7], loop_time=p[8], is_loop=p[9])

    async def write_config(self, cfg):
        c = cfg
        return await self.vendor([0x40, 0xFF, c["motor"], c["brightness"], c["on_time"], c["off_time"],
                                  c["default_scene"], c["last_scene"], c["loop_time"], c["is_loop"]],
                                 wait_for=[0x40])

    async def query_device_type(self):
        p = await self.vendor([0x44, 0xFD], wait_for=[0x44, 0xFD])
        return p[2] if p else None

    async def query_firmware(self):
        p = await self.vendor([0x44, 0xFB], wait_for=[0x44, 0xFB])
        return bytes(p[2:9]).decode(errors="replace").strip("\x00 ") if p else None


def parse_adv(adv):
    """Pull mesh address / product id out of the Telink manufacturer data (DefaultAdvertiseDataFilter)."""
    v = adv.manufacturer_data.get(TELINK_VENDOR_ID)
    if not v or len(v) < 11:
        return None
    return dict(mesh_uuid=v[0] | v[1] << 8, product_uuid=v[6] | v[7] << 8,
                status=v[8], mesh_addr=v[9] | v[10] << 8)


async def scan(timeout=8.0):
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out = []
    for dev, adv in found.values():
        uuids = [u.lower() for u in adv.service_uuids]
        info = parse_adv(adv)
        if info or SERVICE in uuids:
            out.append((dev.address, adv.local_name or dev.name or "", adv.rssi, info))
    return out


async def pick_device(args):
    if args.address and args.name:
        return args.address, args.name, args.mesh_addr
    devices = await scan()
    if not devices:
        sys.exit("No Telink mesh devices found. Is the projector on? Try holding the power button "
                 "until it flashes 6 times to enable Bluetooth.")
    devices.sort(key=lambda d: d[2] or -999, reverse=True)
    addr, name, _rssi, info = devices[0]
    if args.address:
        match = [d for d in devices if d[0].lower() == args.address.lower()]
        if match:
            addr, name, _rssi, info = match[0]
    mesh_addr = args.mesh_addr if args.mesh_addr is not None else (info["mesh_addr"] if info else 0xFFFF)
    print(f"Using {addr}  mesh name '{args.name or name}'  mesh addr 0x{mesh_addr:04x}")
    return addr, args.name or name, mesh_addr


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--address", help="BLE MAC address (default: strongest Telink device)")
    ap.add_argument("--name", help="mesh name (default: the device's advertised name)")
    ap.add_argument("--password", default=DEFAULT_PASSWORD)
    ap.add_argument("--mesh-addr", type=lambda s: int(s, 0), help="target mesh address (default: from advert)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    sub.add_parser("status")
    sub.add_parser("off")
    e = sub.add_parser("effect")
    e.add_argument("effect", help=f"one of {', '.join(EFFECTS)} or a numeric id (DIY: 10-19)")
    r = sub.add_parser("rotation")
    r.add_argument("state", choices=["on", "off"])
    b = sub.add_parser("brightness")
    b.add_argument("level", choices=["low", "medium", "high"])
    lt = sub.add_parser("light", help="manual control (0x47); omitted values keep current state")
    for k in ("red", "green", "blue", "laser", "motor"):
        lt.add_argument(f"--{k}", type=int)
    lt.add_argument("--brightness", type=int, choices=[1, 2, 3])
    lt.add_argument("--fade", type=int, choices=[0, 1])
    t = sub.add_parser("timer", help="auto off/on timer + effect cycling (0x40 0xFF config)")
    t.add_argument("--off-after", type=int, help="auto-off value (0 disables; app used 1..N, likely hours)")
    t.add_argument("--on-after", type=int)
    t.add_argument("--cycle", type=int, help="effect cycle loop time (app offered 0,1,2,3,6,12)")
    raw = sub.add_parser("raw", help="send an arbitrary 0xF0 vendor payload (hex) and print replies")
    raw.add_argument("hex")
    args = ap.parse_args()

    if args.cmd == "scan":
        for addr, name, rssi, info in await scan():
            extra = f"mesh_addr=0x{info['mesh_addr']:04x} product=0x{info['product_uuid']:04x}" if info else ""
            print(f"{addr}  name='{name}'  rssi={rssi}  {extra}")
        return

    addr, name, mesh_addr = await pick_device(args)
    async with BlissLight(addr, name, args.password, mesh_addr) as dev:
        print("Logged in.")
        if args.cmd == "status":
            dt = await dev.query_device_type()
            print("device type:", dt, DEVICE_TYPES.get(dt, "Sky Lite (blue nebula + laser)") if dt is not None else "")
            print("firmware:   ", await dev.query_firmware())
            print("config:     ", await dev.query_config())
            print("light:      ", await dev.query_light())
        elif args.cmd == "off":
            print(await dev.off())
        elif args.cmd == "effect":
            eid = EFFECTS.get(args.effect) if args.effect in EFFECTS else int(args.effect, 0)
            print(await dev.effect(eid))
        elif args.cmd == "rotation":
            print(await dev.rotation(args.state == "on"))
        elif args.cmd == "brightness":
            print(await dev.brightness({"low": 1, "medium": 2, "high": 3}[args.level]))
        elif args.cmd == "light":
            cur = await dev.query_light() or dict(red=0, green=0, blue=255, laser=255, motor=0, brightness=3, fade=0)
            for k in ("red", "green", "blue", "laser", "motor", "brightness", "fade"):
                if getattr(args, k) is not None:
                    cur[k] = getattr(args, k)
            print("sending", cur)
            print(await dev.set_light(cur["red"], cur["green"], cur["blue"], cur["laser"],
                                      cur["motor"], cur["brightness"], cur["fade"]))
        elif args.cmd == "timer":
            cfg = await dev.query_config()
            if not cfg:
                sys.exit("device did not return its config")
            if args.off_after is not None:
                cfg["off_time"] = args.off_after
            if args.on_after is not None:
                cfg["on_time"] = args.on_after
            if args.cycle is not None:
                cfg["loop_time"], cfg["is_loop"] = args.cycle, 1 if args.cycle else 0
            print("writing", cfg)
            print(await dev.write_config(cfg))
        elif args.cmd == "raw":
            await dev.vendor(bytes.fromhex(args.hex))
            try:
                while True:
                    op, src, p = await asyncio.wait_for(dev.replies.get(), 3)
                    print(f"reply op=0x{op:02x} src=0x{src:04x} params={p.hex()}")
            except asyncio.TimeoutError:
                pass


if __name__ == "__main__":
    asyncio.run(main())
