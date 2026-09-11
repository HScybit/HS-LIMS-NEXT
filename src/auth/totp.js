import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]{16,128}=*$/.test(value)) throw new Error('Invalid authenticator secret.');
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const character of value.replace(/=+$/, '')) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpAt(secret, timestamp) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function verifiedTotpStep(secret, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  let matched = null;
  for (const offset of [-1, 0, 1]) {
    const time = now + offset * 30_000;
    if (time >= 0 && timingSafeEqual(Buffer.from(code.trim()), Buffer.from(totpAt(secret, time)))) {
      matched = Math.floor(time / 30_000);
    }
  }
  return matched;
}

function keyBytes(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('A 32-byte MFA encryption key is required.');
  return Buffer.from(key, 'hex');
}

export function encryptSecret(secret, key = process.env.MFA_ENCRYPTION_KEY) {
  decodeBase32(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptSecret(encoded, key = process.env.MFA_ENCRYPTION_KEY) {
  const data = Buffer.from(encoded, 'base64url');
  if (data[0] !== 1 || data.length < 45 || data.toString('base64url') !== encoded) throw new Error('Invalid encrypted authenticator secret.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  const secret = Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString('utf8');
  decodeBase32(secret);
  return secret;
}
