import QRCode from 'qrcode';
import { HttpError } from './errors.js';
import { hashToken } from './tokens.js';
import { buildTotpUri, decryptSecret, encryptSecret, generateTotpSecret, verifiedTotpStep } from './totp.js';

const setupRequired = () => new HttpError(409, 'mfa_setup_required', 'MFA setup expired or changed. Start MFA setup again.');
const staleMfa = () => new HttpError(409, 'stale_mfa', 'MFA changed in another session. Reload your account before trying again.');

function requireId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'invalid_input', 'A valid MFA request identity is required.');
  }
  return value.toLowerCase();
}

async function mfaQuery(client, query, parameters = []) {
  try { return await client.query(query, parameters); }
  catch (error) {
    if (error.code === '28000') throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    throw error;
  }
}

export async function loadMfaStatus(client) {
  const result = await mfaQuery(client, 'SELECT * FROM auth_mfa_state()');
  if (!result.rows[0]) throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
  return result.rows[0];
}

export async function startMfaSetup(client, identity) {
  const result = await mfaQuery(client, 'SELECT * FROM auth_start_mfa_setup($1)', [encryptSecret(generateTotpSecret())]);
  const setup = result.rows[0];
  if (!setup) throw new HttpError(409, 'mfa_enabled', 'MFA is already enabled. Reload your account.');
  const secret = decryptSecret(setup.encrypted_secret);
  const uri = buildTotpUri(secret, identity.username, identity.user_id);
  // Generate locally before committing setup; a QR failure must not leave a hidden new key.
  const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 4, width: 320 });
  return { setupId: setup.id, secret, uri, qrDataUrl, expiresAt: setup.expires_at, revision: setup.mfa_revision };
}

export async function cancelMfaSetup(client, input) {
  await mfaQuery(client, 'SELECT auth_cancel_mfa_setup($1)', [requireId(input?.setupId)]);
  return { ok: true };
}

// Invalid-code outcomes must leave the authenticated transaction before being thrown:
// returning the error lets the limiter commit even though the HTTP response is an error.
export async function verifyMfaSetup(client, identity, input) {
  const setupId = requireId(input?.setupId);
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new HttpError(422, 'invalid_mfa_code', 'Enter the six-digit authenticator code.');
  const result = await mfaQuery(client, 'SELECT * FROM auth_read_mfa_setup($1)', [setupId]);
  const setup = result.rows[0];
  if (!setup) throw setupRequired();
  if (setup.completed) return loadMfaStatus(client);
  const attemptHash = hashToken(`mfa-enable:${identity.user_id}`);
  const attempt = await client.query('SELECT auth_reserve_attempt($1) AS allowed', [attemptHash]);
  if (!attempt.rows[0].allowed) {
    return { error: new HttpError(429, 'rate_limited', 'Too many MFA verification attempts. Try again in 15 minutes.') };
  }
  const step = verifiedTotpStep(decryptSecret(setup.encrypted_secret), code);
  if (step === null) return { error: new HttpError(422, 'invalid_mfa_code', 'The authenticator code is incorrect. Try the current code.') };
  const enabled = await mfaQuery(client, 'SELECT auth_enable_mfa($1, $2, $3) AS revision', [setupId, setup.encrypted_secret, step]);
  if (!enabled.rows[0].revision) return { error: setupRequired() };
  await client.query('SELECT auth_clear_attempts($1)', [attemptHash]);
  return { enabled: true, revision: enabled.rows[0].revision };
}

export async function disableMfa(client, input) {
  const requestId = requireId(input?.requestId);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > 2_147_483_646) {
    throw new HttpError(400, 'invalid_revision', 'Reload your account before changing MFA.');
  }
  const result = await mfaQuery(client, 'SELECT auth_disable_mfa($1, $2) AS revision', [input.revision, requestId]);
  if (result.rows[0].revision === null) throw staleMfa();
  return { enabled: false, revision: result.rows[0].revision };
}
