// Minimal AES-128 block encryption (T-table). Encrypt-only: Telink only ever
// encrypts (CTR stream + CBC-MAC), so decryption is never needed.

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);

(function init() {
  const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = t;
    T1[i] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[i] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
})();

export class AES128 {
  constructor(key) {
    if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
    const w = new Uint32Array(44);
    for (let i = 0; i < 4; i++) {
      w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    let rcon = 1;
    for (let i = 4; i < 44; i++) {
      let t = w[i - 1];
      if (i % 4 === 0) {
        t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) |
             (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
      }
      w[i] = (w[i - 4] ^ t) >>> 0;
    }
    this.w = w;
  }

  // Encrypts 16 bytes from `inp` into `out` (both Uint8Array; may be the same array).
  encryptInto(inp, out) {
    const w = this.w;
    let s0 = ((inp[0] << 24) | (inp[1] << 16) | (inp[2] << 8) | inp[3]) ^ w[0];
    let s1 = ((inp[4] << 24) | (inp[5] << 16) | (inp[6] << 8) | inp[7]) ^ w[1];
    let s2 = ((inp[8] << 24) | (inp[9] << 16) | (inp[10] << 8) | inp[11]) ^ w[2];
    let s3 = ((inp[12] << 24) | (inp[13] << 16) | (inp[14] << 8) | inp[15]) ^ w[3];
    let k = 4;
    for (let r = 1; r < 10; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k++];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k++];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k++];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k++];
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    }
    const f = (a, b, c, d, kw) =>
      ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ kw;
    const r0 = f(s0, s1, s2, s3, w[40]), r1 = f(s1, s2, s3, s0, w[41]);
    const r2 = f(s2, s3, s0, s1, w[42]), r3 = f(s3, s0, s1, s2, w[43]);
    out[0] = r0 >>> 24; out[1] = r0 >>> 16; out[2] = r0 >>> 8; out[3] = r0;
    out[4] = r1 >>> 24; out[5] = r1 >>> 16; out[6] = r1 >>> 8; out[7] = r1;
    out[8] = r2 >>> 24; out[9] = r2 >>> 16; out[10] = r2 >>> 8; out[11] = r2;
    out[12] = r3 >>> 24; out[13] = r3 >>> 16; out[14] = r3 >>> 8; out[15] = r3;
    return out;
  }

  encrypt(block) {
    return this.encryptInto(block, new Uint8Array(16));
  }
}
