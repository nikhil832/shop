import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Time-based one-time codes (RFC 6238, as authenticator apps use them): a shared 160-bit secret, 6 digits, a new code
// every 30 seconds. node:crypto only; tested against the RFC's own test values.
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Base32 (RFC 4648, no padding): how authenticator apps take the secret.
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

// The code for time step `counter` (seconds since 1970 / 30). `digits` is 6 except in the RFC's tests.
export function codeAt(secret, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (time = Date.now()) => Math.floor(time / 1000 / STEP_SECONDS);

// The time step a 6-digit `code` matches (now, or one step either side for clocks a little off), or null. A step at or
// before `lastStep` (the last code used) is refused, so a code can't be used twice.
export function verifyCode(secret, code, { time = Date.now(), lastStep = -1 } = {}) {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepOf(time);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

// What the QR code holds: authenticator apps read the account name, the issuer and the secret from it.
export const otpauthUri = (secret, account, issuer = 'Bazaar') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// One-time recovery codes for a lost phone: 8 of "xxxx-xxxx" (letters and digits that can't be confused).
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}
export const normalizeRecoveryCode = (code) => code.trim().toLowerCase().replace(/\s/g, '');
