// Telink BLE mesh crypto. Same algorithm as poc/telink_crypto.py (see PROTOCOL.md).
// Telink's AES primitive is AES-128-ECB with byte-reversed key, input and output.
import { AES128 } from './aes.js';

const rev = (b) => Uint8Array.from(b).reverse();

export function pad16(s) {
  const b = typeof s === 'string' ? new TextEncoder().encode(s) : Uint8Array.from(s);
  if (b.length > 16) throw new Error('mesh name/password must be at most 16 bytes');
  const out = new Uint8Array(16);
  out.set(b);
  return out;
}

const xor16 = (a, b) => a.map((v, i) => v ^ b[i]);

// AES.encrypt(key, data): reversed key and data, output NOT reversed.
export function aesEncrypt(key, data) {
  return new AES128(rev(key)).encrypt(rev(data));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function makeLoginPacket(name, password, rand8 = crypto.getRandomValues(new Uint8Array(8))) {
  const np = xor16(pad16(name), pad16(password));
  const enc = aesEncrypt(concat(rand8, new Uint8Array(8)), np);
  return { packet: concat([0x0c], rand8, rev(enc.slice(8, 16))), rand: rand8 };
}

export class LoginError extends Error {}

export function makeSessionKey(name, password, loginRand, resp) {
  if (resp[0] === 0x0e) throw new LoginError('The projector rejected the mesh name/password.');
  if (resp[0] !== 0x0d) throw new LoginError(`Unexpected pair response 0x${resp[0].toString(16)}`);
  const devRand = resp.slice(1, 9);
  const np = xor16(pad16(name), pad16(password));
  const proof = rev(aesEncrypt(concat(devRand, new Uint8Array(8)), np).slice(8, 16));
  if (proof.some((v, i) => v !== resp[9 + i])) throw new LoginError('Pair response did not verify (wrong mesh name/password?).');
  return rev(aesEncrypt(np, concat(loginRand, devRand)));
}

// "A4:C1:38:11:22:33" -> Peripheral.getMacBytes() order (33 22 11 38 C1 A4)
export function macRevFromString(mac) {
  const parts = mac.trim().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-fA-F]{2}$/.test(p))) throw new Error('MAC must look like A4:C1:38:12:34:56');
  return Uint8Array.from(parts.map((p) => parseInt(p, 16))).reverse();
}

export function macStringFromRev(macRev4, oui = [0xa4, 0xc1]) {
  // Only the low 4 bytes matter for crypto; the top 2 are cosmetic.
  const b = [...oui, macRev4[3], macRev4[2], macRev4[1], macRev4[0]];
  return b.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export class Session {
  // macRev: at least the first 4 bytes of the reversed MAC (only 0..3 are used).
  constructor(sessionKey, macRev) {
    this.cipher = new AES128(rev(sessionKey));
    this.mac = Uint8Array.from(macRev.slice(0, 4));
  }

  att(data) {
    return this.cipher.encrypt(rev(data)).reverse();
  }

  encryptCommand(pkt) {
    pkt = Uint8Array.from(pkt);
    const nonce = concat(this.mac, [0x01], pkt.slice(0, 3));
    let a = this.att(concat(nonce, [0x0f], new Uint8Array(7)));
    for (let i = 0; i < 15; i++) a[i] ^= pkt[i + 5];
    a = this.att(a);
    pkt[3] = a[0]; pkt[4] = a[1];
    const stream = this.att(concat([0], nonce, new Uint8Array(7)));
    for (let i = 0; i < 15; i++) pkt[i + 5] ^= stream[i];
    return pkt;
  }

  decryptNotify(data) {
    return decryptNotifyWith(this, this.mac, data);
  }
}

export function decryptNotifyWith(session, mac3, data) {
  data = Uint8Array.from(data);
  const nonce = concat(mac3.slice(0, 3), data.slice(0, 5));
  const stream = session.att(concat([0], nonce, new Uint8Array(7)));
  for (let i = 0; i < 13; i++) data[i + 7] ^= stream[i];
  let a = session.att(concat(nonce, [0x0d], new Uint8Array(7)));
  for (let i = 0; i < 13; i++) a[i] ^= data[i + 7];
  a = session.att(a);
  if (data[5] !== a[0] || data[6] !== a[1]) return null;
  return data;
}

// Test helper / inverse of decryptNotify (what the projector does).
export function encryptNotify(session, mac3, plain) {
  const data = Uint8Array.from(plain);
  const nonce = concat(mac3.slice(0, 3), data.slice(0, 5));
  let a = session.att(concat(nonce, [0x0d], new Uint8Array(7)));
  for (let i = 0; i < 13; i++) a[i] ^= data[i + 7];
  a = session.att(a);
  data[5] = a[0]; data[6] = a[1];
  const stream = session.att(concat([0], nonce, new Uint8Array(7)));
  for (let i = 0; i < 13; i++) data[i + 7] ^= stream[i];
  return data;
}
