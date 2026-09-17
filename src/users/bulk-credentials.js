import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { HttpError } from '../auth/errors.js';
import { hashPassword } from '../auth/passwords.js';
import { bindUserBulkHeaders } from './bulk-input.js';

const maximumPreparationMs = 300_000;
let activePreparations = 0;

function fingerprint(domain, value, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'account_command_key_unavailable', 'Account creation is temporarily unavailable.');
  const derived = createHmac('sha256', Buffer.from(key, 'hex')).update(`SampleifyLIMS/user-bulk/${domain}/key/v1`).digest();
  return createHmac('sha256', derived).update(value).digest();
}

export function userBulkSourceFingerprint(bytes, key = process.env.MFA_ENCRYPTION_KEY) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 16 * 1_048_576) throw new HttpError(400, 'invalid_bulk_file', 'Provide a User upload of at most 16 MiB.');
  // A public fast file hash would also be a password-guessing oracle.
  return fingerprint('source', bytes, key).toString('hex');
}

export async function prepareUserBulkCredential(value, metadata, key = process.env.MFA_ENCRYPTION_KEY) {
  const scalar = value == null ? '' : typeof value === 'string' ? value.trim()
    : typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  const unusable = metadata?.type === 'error' || metadata?.errorCode != null
    || metadata?.type === 'formula' && metadata.hasResult !== true;
  const state = unusable || scalar === null ? 'invalid' : scalar === '' ? 'missing'
    : scalar.length < 8 || scalar.length > 200 || !scalar.isWellFormed() ? 'invalid' : 'valid';
  const credentialFingerprint = fingerprint('password', JSON.stringify([state, scalar, Boolean(unusable)]), key).toString('hex');
  return { state, fingerprint: credentialFingerprint, passwordHash: state === 'valid' ? await hashPassword(scalar) : null };
}

export async function prepareUserBulkDecoded(decoded, { key = process.env.MFA_ENCRYPTION_KEY, signal, timeoutMs = maximumPreparationMs } = {}) {
  const columns = bindUserBulkHeaders(decoded?.sourceHeaders);
  const passwordColumn = columns.find(column => column.kind === 'password').columnNumber;
  const validMetadata = value => value == null || Array.isArray(value) && Array.from(value).every(cell => cell
    && Number.isInteger(cell.columnNumber) && cell.columnNumber > 0 && cell.columnNumber <= 250);
  if (!Array.isArray(decoded.rows) || !decoded.rows.length || decoded.rows.length > 2500
    || !validMetadata(decoded.headerCellMetadata)
    || Array.from(decoded.rows).some(row => !row || !Array.isArray(row.values) || row.values.length > 250 || !validMetadata(row.cellMetadata)
      || row.values.slice(columns.length).some(value => value != null && (typeof value !== 'string' || value.trim() !== '')))) {
    throw new HttpError(400, 'invalid_bulk_input', 'Upload between 1 and 2,500 User rows.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumPreparationMs) throw new HttpError(400, 'invalid_bulk_timeout', 'User upload time limits must be between 1 and 300,000 milliseconds.');
  if (activePreparations >= 2) throw new HttpError(429, 'user_bulk_busy', 'User uploads are busy. Try again shortly.');
  activePreparations++;
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    if (signal?.aborted) throw new HttpError(400, 'incomplete_bulk_file', 'The file upload did not finish. Try again.');
    if (performance.now() > deadline) throw new HttpError(408, 'user_bulk_timeout', 'User password preparation timed out. Try a smaller upload.');
  };
  try {
    const rows = []; const credentials = [];
    for (const row of decoded.rows) {
      check();
      const metadata = row.cellMetadata ?? [];
      const credential = await prepareUserBulkCredential(row.values[passwordColumn - 1], metadata.find(cell => cell.columnNumber === passwordColumn), key);
      check();
      const values = [...row.values]; values[passwordColumn - 1] = '';
      rows.push({ ...row, values, cellMetadata: metadata.filter(cell => cell.columnNumber !== passwordColumn).map(cell => ({ ...cell })) });
      credentials.push(credential);
    }
    return { decoded: { ...decoded, headers: columns.map(column => column.header), sourceHeaders: [...decoded.sourceHeaders], rows,
      headerCellMetadata: (decoded.headerCellMetadata ?? []).filter(cell => cell.columnNumber !== passwordColumn).map(cell => ({ ...cell })) }, credentials };
  } finally { activePreparations--; }
}
