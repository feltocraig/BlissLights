// Web Bluetooth driver for BlissLights Sky Lite projectors (Telink BLE mesh).
// Protocol: see PROTOCOL.md at the repo root.
import { makeLoginPacket, makeSessionKey, Session, decryptNotifyWith, macStringFromRev, LoginError } from './telink.js';

export const SERVICE = '00010203-0405-0607-0809-0a0b0c0d1910';
const CHAR_NOTIFY = '00010203-0405-0607-0809-0a0b0c0d1911';
const CHAR_COMMAND = '00010203-0405-0607-0809-0a0b0c0d1912';
const CHAR_PAIR = '00010203-0405-0607-0809-0a0b0c0d1914';
const TELINK_VENDOR = 0x0211;
export const DEFAULT_PASSWORD = '123';
const OP_VENDOR = 0xf0;

export const EFFECTS = [
  { id: 1, name: 'Stars against nebula' },
  { id: 2, name: 'Fading' },
  { id: 3, name: 'Stars' },
  { id: 4, name: 'Nebula' },
  { id: 5, name: 'Ocean' },
  { id: 6, name: 'Space' },
  { id: 8, name: 'Sunrise' },
  { id: 9, name: 'RGB auto' },
];

export const DEVICE_TYPES = { 3: 'Sky Lite Evolve (RGB + laser)', 4: 'RGB projector', 5: 'BlissGlow strip' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class Projector extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.session = null;
    this.mac4 = null;
    // Broadcast address: the projector the phone is connected to (and any others sharing
    // its mesh name) all act on it, which is also how the original app's "all" mode worked.
    this.meshAddr = 0xffff;
    this.seq = Math.floor(Math.random() * 0xfffff) + 1;
    this.raw = [];          // encrypted notifications received before the MAC is known
    this.waiters = [];
    this.writeChain = Promise.resolve();
  }

  log(msg) {
    this.dispatchEvent(new CustomEvent('log', { detail: msg }));
  }

  status(msg) {
    this.dispatchEvent(new CustomEvent('status', { detail: msg }));
  }

  async pick({ showAll = false } = {}) {
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ manufacturerData: [{ companyIdentifier: TELINK_VENDOR }] }, { services: [SERVICE] }], optionalServices: [SERVICE] };
    try {
      this.device = await navigator.bluetooth.requestDevice(opts);
    } catch (e) {
      // Some browsers (e.g. older Bluefy) reject manufacturerData filters.
      if (!showAll && e.name === 'TypeError') return this.pick({ showAll: true });
      throw e;
    }
    this.device.addEventListener('gattserverdisconnected', () => this.dispatchEvent(new Event('disconnected')));
    return this.device;
  }

  savedSettings() {
    return store(`dev:${this.device.id}`) || {};
  }

  saveSettings(patch) {
    store(`dev:${this.device.id}`, { ...this.savedSettings(), ...patch });
  }

  forget() {
    store(`dev:${this.device.id}`, null);
  }

  meshName() {
    return this.savedSettings().meshName || this.device.name || '';
  }

  async connect({ meshName, password = DEFAULT_PASSWORD, macHint } = {}) {
    meshName = meshName || this.meshName();
    if (!meshName) throw new LoginError('This browser did not report the projector\'s Bluetooth name. Enter the mesh name under Advanced.');

    const advMac = macHint ? null : this.watchAdvertMac();
    this.status('Connecting…');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.chPair = await svc.getCharacteristic(CHAR_PAIR);
    this.chCmd = await svc.getCharacteristic(CHAR_COMMAND);
    this.chNotify = await svc.getCharacteristic(CHAR_NOTIFY);

    this.status('Logging in…');
    const { packet, rand } = makeLoginPacket(meshName, password);
    await this.chPair.writeValueWithResponse(packet);
    const resp = new Uint8Array((await this.chPair.readValue()).buffer);
    this.sessionKey = makeSessionKey(meshName, password, rand, resp);
    this.log(`logged in as mesh '${meshName}'`);

    this.chNotify.addEventListener('characteristicvaluechanged', (e) => this.onNotify(new Uint8Array(e.target.value.buffer)));
    await this.chNotify.startNotifications();
    await this.chNotify.writeValueWithResponse(Uint8Array.of(1));

    this.status('Securing connection…');
    await this.resolveMac(macHint, await advMac);
    this.saveSettings({ meshName, mac4: hex(this.mac4) });
    this.status('Connected');
  }

  // Telink adverts carry the low 4 bytes of the (reversed) MAC right after the mesh UUID.
  // watchAdvertisements is still experimental in most browsers, so this is best-effort.
  async watchAdvertMac(timeout = 2500) {
    if (!this.device.watchAdvertisements) return null;
    try {
      const ac = new AbortController();
      const got = new Promise((resolve) => {
        this.device.addEventListener('advertisementreceived', (e) => {
          const dv = e.manufacturerData && e.manufacturerData.get(TELINK_VENDOR);
          if (dv && dv.byteLength >= 6) resolve(Uint8Array.of(dv.getUint8(2), dv.getUint8(3), dv.getUint8(4), dv.getUint8(5)));
        }, { once: true });
      });
      await this.device.watchAdvertisements({ signal: ac.signal });
      const r = await Promise.race([got, sleep(timeout).then(() => null)]);
      ac.abort();
      return r;
    } catch { return null; }
  }

  async resolveMac(macHint, advMac) {
    const candidates = [];
    if (macHint) candidates.push(macHint);
    const saved = this.savedSettings().mac4;
    if (saved) candidates.push(Uint8Array.from(saved.match(/../g), (x) => parseInt(x, 16)));
    if (advMac) candidates.push(advMac);
    for (const c of candidates) {
      if (await this.tryMac(c)) return;
    }

    // Recover from encrypted notifications. The projector sends a status report right after
    // notifications are enabled; give it a moment to arrive.
    this.status('Finding the projector\'s key… (one-time, a few seconds)');
    for (let i = 0; i < 30 && this.raw.length === 0; i++) await sleep(100);
    if (this.raw.length === 0) throw new Error('The projector did not send any status. Enter its MAC address under Advanced and reconnect.');
    const mac3 = await this.searchMac3(this.raw.slice(0, 4));
    if (!mac3) throw new Error('Could not derive the projector\'s address. Enter its MAC address under Advanced.');

    // Byte 4 of the reversed MAC is the last byte of the manufacturer prefix. Telink's own
    // prefix (A4:C1:38) is by far the most common, so try 0x38 first.
    // Notifications only need mac[0..2], so this session can already read replies.
    this.session = new Session(this.sessionKey, Uint8Array.of(...mac3, 0x38));
    if (await this.tryMac(Uint8Array.of(...mac3, 0x38))) return;
    this.status('Almost there… (checking the last address byte)');
    const b4 = await this.searchByte4(mac3);
    if (b4 === null || !(await this.tryMac(Uint8Array.of(...mac3, b4)))) {
      throw new Error('Could not verify the projector\'s address. Enter its MAC address under Advanced.');
    }
  }

  async searchMac3(packets) {
    const worker = new Worker(new URL('./macsearch.worker.js', import.meta.url), { type: 'module' });
    try {
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.progress !== undefined) this.dispatchEvent(new CustomEvent('progress', { detail: e.data.progress }));
          else resolve(e.data.found);
        };
        worker.onerror = (e) => reject(new Error(e.message || 'MAC search failed'));
        worker.postMessage({ sessionKey: this.sessionKey, packets });
      });
      this.dispatchEvent(new CustomEvent('progress', { detail: null }));
      // Several packets → keep the candidate that decrypts all of them.
      const verify = new Session(this.sessionKey, new Uint8Array(4));
      const ok = result.filter((m) => packets.every((p) => decryptNotifyWith(verify, m, p)));
      this.log(`mac search: ${result.length} candidate(s), ${ok.length} verified`);
      return ok.length >= 1 ? Uint8Array.from(ok[0]) : null;
    } finally {
      worker.terminate();
    }
  }

  // Halve the 256 possibilities each round: send one query per guess, see if anything answers.
  async searchByte4(mac3) {
    let lo = 0, hi = 256;
    const s = new Session(this.sessionKey, Uint8Array.of(...mac3, 0));
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      this.drainWaiters();
      const reply = this.waitFor([0x44, 0xfb], 1500);
      for (let b = lo; b < mid; b++) {
        s.mac[3] = b;
        await this.writeRaw(s, OP_VENDOR, [0x44, 0xfb], 0xffff);
      }
      if (await reply) hi = mid; else lo = mid;
      await sleep(300);
    }
    return lo;
  }

  async tryMac(mac4) {
    const prev = this.session;
    this.session = new Session(this.sessionKey, mac4);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.vendor([0x44, 0xfb], { wait: [0x44, 0xfb], timeout: 1500, dst: 0xffff });
      if (r) {
        this.mac4 = Uint8Array.from(mac4);
        this.firmware = parseFirmware(r);
        this.log(`address verified (${macStringFromRev(this.mac4)})`);
        this.flushRaw();
        return true;
      }
    }
    this.session = prev;
    return false;
  }

  flushRaw() {
    const pending = this.raw;
    this.raw = [];
    for (const p of pending) this.onNotify(p);
  }

  onNotify(data) {
    if (!this.session) { this.raw.push(data); return; }
    const plain = this.session.decryptNotify(data);
    if (!plain) {
      if (!this.mac4) this.raw.push(data);
      return;
    }
    const op = plain[7];
    const src = plain[3] | (plain[4] << 8);
    const params = plain.slice(10, 20);
    this.log(`← op ${op.toString(16)} from ${src.toString(16)}: ${hex(params)}`);
    this.waiters = this.waiters.filter((w) => {
      if (w.prefix.every((b, i) => params[i] === b)) { w.resolve(params); return false; }
      return true;
    });
    if (op === 0xeb || op === 0xea) this.dispatchEvent(new CustomEvent('report', { detail: params }));
  }

  waitFor(prefix, timeout) {
    return new Promise((resolve) => {
      const w = { prefix, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, timeout);
    });
  }

  drainWaiters() {
    for (const w of this.waiters) w.resolve(null);
    this.waiters = [];
  }

  writeRaw(session, opcode, params, dst) {
    const s = this.seq;
    this.seq = (this.seq + 1) & 0xffffff;
    const pkt = new Uint8Array(20);
    pkt.set([s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, 0, 0, dst & 0xff, (dst >> 8) & 0xff, opcode | 0xc0, TELINK_VENDOR & 0xff, TELINK_VENDOR >> 8]);
    pkt.set(params.slice(0, 10), 10);
    const enc = session.encryptCommand(pkt);
    // Web Bluetooth rejects overlapping GATT operations, so serialize writes.
    const p = this.writeChain.then(() => this.chCmd.writeValueWithoutResponse(enc));
    this.writeChain = p.catch(() => {});
    return p;
  }

  async vendor(params, { wait, timeout = 2500, dst } = {}) {
    if (!this.session) throw new Error('not connected');
    const reply = wait ? this.waitFor(wait, timeout) : null;
    this.log(`→ ${hex(params)}`);
    await this.writeRaw(this.session, OP_VENDOR, params, dst ?? this.meshAddr);
    return reply ? await reply : null;
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  // ---- projector commands (from Fra_MainHome.java in the original app) ----
  off() { return this.vendor([0x41, 0x00, 0x01], { wait: [0x41] }); }
  effect(id) { return this.vendor([0x41, id, 0x00], { wait: [0x41] }); }
  rotation(on) { return this.vendor([0x42, on ? 0xff : 0x00], { wait: [0x42] }); }
  brightness(level) { return this.vendor([0x43, level], { wait: [0x43] }); }

  setLight({ red, green, blue, laser, motor, brightness, fade }) {
    return this.vendor([0x47, red, green, blue, laser, motor, brightness, fade], { wait: [0x47] });
  }

  async queryLight() {
    const p = await this.vendor([0x48], { wait: [0x48] });
    return p && { red: p[1], green: p[2], blue: p[3], laser: p[4], motor: p[5], brightness: p[6], fade: p[7] };
  }

  async queryConfig() {
    const p = await this.vendor([0x44, 0xff], { wait: [0x44, 0xff] });
    return p && { motor: p[2], brightness: p[3], onTime: p[4], offTime: p[5], defaultScene: p[6], lastScene: p[7], loopTime: p[8], isLoop: p[9] };
  }

  writeConfig(c) {
    return this.vendor([0x40, 0xff, c.motor, c.brightness, c.onTime, c.offTime, c.defaultScene, c.lastScene, c.loopTime, c.isLoop], { wait: [0x40] });
  }

  async queryDeviceType() {
    const p = await this.vendor([0x44, 0xfd], { wait: [0x44, 0xfd] });
    return p ? p[2] : null;
  }

  async queryFirmware() {
    return parseFirmware(await this.vendor([0x44, 0xfb], { wait: [0x44, 0xfb] }));
  }

  // Effect-cycle playlist: three packets of 8 ids, each sent after the previous is acked.
  async setPlaylist(ids) {
    const all = [...ids, ...Array(24).fill(0)].slice(0, 24);
    for (let pkg = 0; pkg < 3; pkg++) {
      const ack = await this.vendor([0x50, pkg, ...all.slice(pkg * 8, pkg * 8 + 8)], { wait: [0x50, pkg] });
      if (!ack) return false;
    }
    return true;
  }
}

function parseFirmware(p) {
  if (!p) return null;
  return new TextDecoder().decode(p.slice(2, 9)).replace(/[\0\s]+$/g, '').trim() || null;
}
