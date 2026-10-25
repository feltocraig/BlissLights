"""Telink BLE mesh crypto, ported from com.telink.crypto.AES and
com.telink.bluetooth.light.LightController in the BlissLights 3.3.67 APK.

Telink does AES-128-ECB with byte-reversed key/input/output; everything else
(CCM-like MIC + CTR stream) is built on top of that single primitive.
"""
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def _ecb(key: bytes, data: bytes) -> bytes:
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return enc.update(data) + enc.finalize()


def aes_encrypt(key: bytes, data: bytes) -> bytes:
    """AES.encrypt(key, data): reverse key and data, output NOT reversed."""
    return _ecb(key[::-1], data[::-1])


def aes_att(key: bytes, data: bytes) -> bytes:
    """AES.aes_att_encryption: reverse key, data and output."""
    return aes_encrypt(key, data)[::-1]


def pad16(s) -> bytes:
    b = s.encode() if isinstance(s, str) else bytes(s)
    if len(b) > 16:
        raise ValueError("mesh name/password must be <= 16 bytes")
    return b.ljust(16, b"\x00")


def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


def make_login_packet(name, password, rand8: bytes = None):
    """Returns (packet_to_write_to_pair_char, login_random)."""
    rand8 = rand8 or os.urandom(8)
    np = _xor(pad16(name), pad16(password))
    enc = aes_encrypt(rand8 + b"\x00" * 8, np)
    # opcode 0x0C, 8 random bytes, then enc[8:16] reversed (Arrays.reverse(pkt, 9, 16))
    return bytes([0x0C]) + rand8 + enc[8:16][::-1], rand8


def make_session_key(name, password, login_rand: bytes, response: bytes) -> bytes:
    """response = bytes read back from the pair characteristic (starts with 0x0D)."""
    if response[0] == 0x0E:
        raise PermissionError("device rejected mesh name/password (PAIR_ENC_FAIL)")
    if response[0] != 0x0D:
        raise ValueError(f"unexpected pair response opcode 0x{response[0]:02x}")
    dev_rand = response[1:9]
    np = _xor(pad16(name), pad16(password))
    check = dev_rand + aes_encrypt(dev_rand + b"\x00" * 8, np)[8:16][::-1]
    if check != response[1:17]:
        raise PermissionError("device pair response did not verify (wrong name/password?)")
    return aes_encrypt(np, login_rand + dev_rand)[::-1]


def mac_bytes(mac: str) -> bytes:
    """Peripheral.getMacBytes(): 'A4:C1:38:11:22:33' -> 33 22 11 38 C1 A4."""
    return bytes(int(x, 16) for x in mac.split(":"))[::-1]


def encrypt_command(sk: bytes, mac: str, pkt: bytes) -> bytes:
    """Encrypt a 20-byte command packet in place (MIC into bytes 3-4, CTR over 5-19)."""
    pkt = bytearray(pkt)
    m = mac_bytes(mac)
    nonce = m[:4] + b"\x01" + bytes(pkt[0:3])  # getSecIVM (verified against bytecode)

    a = bytearray(aes_att(sk, nonce + b"\x0f" + b"\x00" * 7))
    for i in range(15):
        a[i] ^= pkt[i + 5]
    a = aes_att(sk, bytes(a))
    pkt[3], pkt[4] = a[0], a[1]

    ctr = bytearray(b"\x00" + nonce + b"\x00" * 7)
    stream = aes_att(sk, bytes(ctr))
    for i in range(15):
        pkt[i + 5] ^= stream[i]
    return bytes(pkt)


def decrypt_notify(sk: bytes, mac: str, data: bytes):
    """Decrypt a 20-byte notification. Returns plaintext or None if MIC fails."""
    data = bytearray(data)
    m = mac_bytes(mac)
    nonce = m[:3] + bytes(data[0:5])  # getSecIVS + notify bytes 0..4

    stream = aes_att(sk, b"\x00" + nonce + b"\x00" * 7)
    for i in range(13):
        data[i + 7] ^= stream[i]

    a = bytearray(aes_att(sk, nonce + b"\x0d" + b"\x00" * 7))
    for i in range(13):
        a[i] ^= data[i + 7]
    a = aes_att(sk, bytes(a))
    if data[5] != a[0] or data[6] != a[1]:
        return None
    return bytes(data)
