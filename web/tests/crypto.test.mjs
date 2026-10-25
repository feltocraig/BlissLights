// node web/tests/crypto.test.mjs
// Checks the browser crypto against vectors produced by poc/telink_crypto.py
// (which was itself checked against the APK's Java code).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { makeLoginPacket, makeSessionKey, Session, macRevFromString, encryptNotify, decryptNotifyWith } from '../js/telink.js';
import { searchMac3 } from '../js/macsearch.js';

const here = new URL('.', import.meta.url);
const v = JSON.parse(readFileSync(new URL('vectors.json', here)));
const hex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const toHex = (b) => Buffer.from(b).toString('hex');

const { packet } = makeLoginPacket(v.name, v.pw, hex(v.rand));
assert.equal(toHex(packet), v.login, 'login packet');

const sk = makeSessionKey(v.name, v.pw, hex(v.rand), hex(v.resp));
assert.equal(toHex(sk), v.sk, 'session key');
assert.throws(() => makeSessionKey(v.name, 'nope', hex(v.rand), hex(v.resp)), 'wrong password must fail');

const macRev = macRevFromString(v.mac);
const s = new Session(sk, macRev);
assert.equal(toHex(s.encryptCommand(hex(v.cmd))), v.cmd_enc, 'command encryption');

// A notification the projector might send: seq, src 0x0034, MIC, op 0xDC, vendor 0x0211, params
const plain = hex('a1b2c3' + '3400' + '0000' + 'dc' + '1102' + '34016400000000000000');
const note = encryptNotify(s, macRev, plain);
assert.equal(toHex(decryptNotifyWith(s, macRev, note).slice(7)), toHex(plain.slice(7)), 'notify round trip');

// Cross-check our notify encryption with Python's decrypt_notify
const py = execFileSync(new URL('../../.venv/Scripts/python.exe', here).pathname.replace(/^\/(\w:)/, '$1'), ['-I', '-c',
  `import sys; sys.path.insert(0, r'${new URL('../../poc', here).pathname.replace(/^\/(\w:)/, '$1')}');` +
  `import telink_crypto as t; r=t.decrypt_notify(bytes.fromhex('${v.sk}'), '${v.mac}', bytes.fromhex('${toHex(note)}')); print(r.hex() if r else 'None')`]).toString().trim();
assert.equal(py.slice(14), toHex(plain).slice(14), 'python decrypts JS-encrypted notify');

// MAC recovery from a single notification
const t0 = performance.now();
const found = searchMac3(sk, [note]);
const ms = Math.round(performance.now() - t0);
assert.ok(found.some((m) => m[0] === macRev[0] && m[1] === macRev[1] && m[2] === macRev[2]), 'MAC search finds the MAC');
console.log(`MAC search: ${found.length} candidate(s) in ${ms} ms`);
console.log('all crypto tests passed');
