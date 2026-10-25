// A simulated Sky Lite projector behind a fake navigator.bluetooth, for testing the
// web app end to end without hardware. It implements the *device* side of the Telink
// protocol: verifies the login proof, decrypts commands (rejecting bad MICs, exactly like
// the real firmware), and answers with encrypted notifications.
//
// In the browser console on the app page:
//   const f = await import('./tests/fake-bluetooth.js'); f.install({ mac: 'D0:3E:7D:5E:9F:21' });
import { pad16, aesEncrypt, Session, encryptNotify, macRevFromString } from '../js/telink.js';

const rev = (b) => Uint8Array.from(b).reverse();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeChar extends EventTarget {
  constructor(uuid) { super(); this.uuid = uuid; this.value = null; }
}

export function install({ name = 'a1b2c3d4e5f6', password = '123', mac = 'D0:3E:7D:5E:9F:21', deviceType = 3, log = console.log } = {}) {
  const macRev = macRevFromString(mac);
  const np = pad16(name).map((v, i) => v ^ pad16(password)[i]);
  const st = {
    session: null, loginRand: null, devRand: crypto.getRandomValues(new Uint8Array(8)), seq: 1,
    cfg: { motor: 255, brightness: 3, onTime: 0, offTime: 0, defaultScene: 1, lastScene: 1, loopTime: 0, isLoop: 0 },
    light: { red: 0, green: 0, blue: 255, laser: 255, motor: 255, brightness: 3, fade: 0 },
    rejected: 0, accepted: 0,
  };
  const pair = new FakeChar('pair'), cmd = new FakeChar('cmd'), notify = new FakeChar('notify');

  function emit(params, op = 0xeb) {
    const s = st.seq++;
    const plain = new Uint8Array(20);
    plain.set([s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, 0x01, 0x00, 0, 0, op, 0x11, 0x02]);
    plain.set(params.slice(0, 10), 10);
    const data = encryptNotify(st.session, macRev, plain);
    setTimeout(() => { notify.value = new DataView(data.buffer); notify.dispatchEvent(new Event('characteristicvaluechanged')); }, 40);
  }

  function decryptCommand(enc) {
    const pkt = Uint8Array.from(enc);
    const nonce = new Uint8Array([...macRev.slice(0, 4), 1, ...pkt.slice(0, 3)]);
    const stream = st.session.att(new Uint8Array([0, ...nonce, 0, 0, 0, 0, 0, 0, 0]));
    for (let i = 0; i < 15; i++) pkt[i + 5] ^= stream[i];
    let a = st.session.att(new Uint8Array([...nonce, 0x0f, 0, 0, 0, 0, 0, 0, 0]));
    for (let i = 0; i < 15; i++) a[i] ^= pkt[i + 5];
    a = st.session.att(a);
    return a[0] === enc[3] && a[1] === enc[4] ? pkt : null;
  }

  function handle(p) {
    const c = st.cfg, L = st.light;
    switch (p[0]) {
      case 0x41: if (p[2] === 1 && p[1] === 0) c.lastScene = 0; else c.lastScene = p[1]; emit([0x41, c.lastScene]); break;
      case 0x42: c.motor = L.motor = p[1]; emit([0x42, p[1]]); break;
      case 0x43: c.brightness = L.brightness = p[1]; emit([0x43, p[1]]); break;
      case 0x47: Object.assign(L, { red: p[1], green: p[2], blue: p[3], laser: p[4], motor: p[5], brightness: p[6], fade: p[7] }); emit([...p.slice(0, 8)]); break;
      case 0x48: emit([0x48, L.red, L.green, L.blue, L.laser, L.motor, L.brightness, L.fade]); break;
      case 0x40: if (p[1] === 0xff) Object.assign(c, { motor: p[2], brightness: p[3], onTime: p[4], offTime: p[5], defaultScene: p[6], lastScene: p[7], loopTime: p[8], isLoop: p[9] }); emit([...p.slice(0, 10)]); break;
      case 0x50: emit([0x50, p[1], 0, 0, 0, 0, 0, 0, 0, 0]); break;
      case 0x44:
        if (p[1] === 0xff) emit([0x44, 0xff, c.motor, c.brightness, c.onTime, c.offTime, c.defaultScene, c.lastScene, c.loopTime, c.isLoop]);
        else if (p[1] === 0xfd) emit([0x44, 0xfd, deviceType]);
        else if (p[1] === 0xfb) emit([0x44, 0xfb, ...new TextEncoder().encode('v001.13')]);
        break;
    }
  }

  pair.writeValueWithResponse = async (pkt) => {
    st.loginRand = pkt.slice(1, 9);
    const expect = rev(aesEncrypt(new Uint8Array([...st.loginRand, 0, 0, 0, 0, 0, 0, 0, 0]), np).slice(8, 16));
    st.loginOk = expect.every((v, i) => v === pkt[9 + i]);
  };
  pair.readValue = async () => {
    if (!st.loginOk) return new DataView(Uint8Array.of(0x0e).buffer);
    const proof = rev(aesEncrypt(new Uint8Array([...st.devRand, 0, 0, 0, 0, 0, 0, 0, 0]), np).slice(8, 16));
    const sk = rev(aesEncrypt(np, new Uint8Array([...st.loginRand, ...st.devRand])));
    st.session = new Session(sk, macRev);
    return new DataView(new Uint8Array([0x0d, ...st.devRand, ...proof]).buffer);
  };
  notify.startNotifications = async () => notify;
  notify.writeValueWithResponse = async () => { await sleep(150); emit([0x01, 0x00, 0x64, 0x00], 0xdc); }; // online status
  cmd.writeValueWithoutResponse = async (enc) => {
    await sleep(2);
    const pkt = decryptCommand(enc);
    if (!pkt) { st.rejected++; return; }
    st.accepted++;
    log('[fake projector] got', Array.from(pkt.slice(10), (v) => v.toString(16).padStart(2, '0')).join(''));
    handle(pkt.slice(10));
  };

  const service = { getCharacteristic: async (u) => ({ 1914: pair, 1912: cmd, 1911: notify })[u.slice(-4)] };
  const device = new EventTarget();
  Object.assign(device, {
    id: 'fake-1', name,
    gatt: {
      connected: false,
      connect: async () => { device.gatt.connected = true; await sleep(100); return device.gatt; },
      disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
      getPrimaryService: async () => service,
    },
  });
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
  return st;
}
