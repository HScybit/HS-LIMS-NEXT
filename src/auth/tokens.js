import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, 'base64url').toString('base64url') === token;

export function matchesToken(token, expectedHash) {
  if (!validToken(token) || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(expectedHash, 'hex'));
}
