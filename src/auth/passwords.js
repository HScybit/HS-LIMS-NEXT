import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = Buffer.alloc(16, 1);
const dummyDigest = Buffer.alloc(64);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('Password must contain between 8 and 200 characters.');
  }
  const salt = randomBytes(16);
  const digest = await derive(password, salt, 64, options);
  return `scrypt$1$32768$8$1$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function parseHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = /^scrypt\$1\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url');
  const digest = Buffer.from(match[2], 'base64url');
  if (salt.toString('base64url') !== match[1] || digest.toString('base64url') !== match[2]) return null;
  return { salt, digest };
}

export async function verifyPassword(password, encoded) {
  const parsed = parseHash(encoded);
  const validInput = typeof password === 'string' && password.length > 0 && password.length <= 200;
  const digest = await derive(validInput ? password : '', parsed?.salt ?? dummySalt, 64, options);
  const matches = timingSafeEqual(digest, parsed?.digest ?? dummyDigest);
  return Boolean(validInput && parsed && matches);
}
