// Recover the low 3 MAC bytes from encrypted notifications.
//
// Web Bluetooth hides the MAC address, but Telink uses mac[0..2] (reversed MAC)
// in the notification nonce. After login we know the session key, so we can try
// all 2^24 possibilities against a real notification: the right one decrypts to
// vendor id 0x0211 and passes the 16-bit MIC. This is the inner loop, hand-inlined
// to avoid allocations (see decryptNotifyWith in telink.js for the readable form).
import { AES128 } from './aes.js';

export function searchMac3(sessionKey, packets, { strict = true, onProgress } = {}) {
  const cipher = new AES128(Uint8Array.from(sessionKey).reverse());
  const d = packets[0];
  const X = new Uint8Array(16), Y = new Uint8Array(16), B = new Uint8Array(16);
  const P = new Uint8Array(20);
  const found = [];
  // revX = [0*7, d4 d3 d2 d1 d0, m2 m1 m0, 0]
  X[7] = d[4]; X[8] = d[3]; X[9] = d[2]; X[10] = d[1]; X[11] = d[0];
  for (let c = 0; c < 0x1000000; c++) {
    if (onProgress && (c & 0xfffff) === 0) onProgress(c / 0x1000000);
    const m0 = c & 0xff, m1 = (c >>> 8) & 0xff, m2 = c >>> 16;
    X[12] = m2; X[13] = m1; X[14] = m0; X[15] = 0;
    cipher.encryptInto(X, Y);
    // plain[7+i] = d[7+i] ^ Y[15-i]
    if (strict && ((d[8] ^ Y[14]) !== 0x11 || (d[9] ^ Y[13]) !== 0x02)) continue;
    if (!strict && ((d[7] ^ Y[15]) & 0xc0) !== 0xc0) continue;
    for (let i = 0; i < 13; i++) P[7 + i] = d[7 + i] ^ Y[15 - i];
    // MIC: Z = E([0*7, 0x0d, d4..d0, m2 m1 m0]); B = Z ^ plain; W = E(B)
    B.fill(0);
    B[7] = 0x0d; B[8] = d[4]; B[9] = d[3]; B[10] = d[2]; B[11] = d[1]; B[12] = d[0];
    B[13] = m2; B[14] = m1; B[15] = m0;
    cipher.encryptInto(B, B);
    for (let j = 3; j < 16; j++) B[j] ^= P[22 - j];
    cipher.encryptInto(B, B);
    if (B[15] === d[5] && B[14] === d[6]) found.push([m0, m1, m2]);
  }
  return found;
}
