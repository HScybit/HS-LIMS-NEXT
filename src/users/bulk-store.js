import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';

export async function storeUserBulkCredentials(client, identity, batchId, rows, credentials) {
  requirePermission(identity, 'users.manage');
  if (!Array.isArray(credentials) || credentials.length !== rows.length || !rows.length || rows.length > 2500
    || Array.from(credentials).some(credential => !credential || !['valid', 'missing', 'invalid'].includes(credential.state)
      || !/^[a-f0-9]{64}$/.test(credential.fingerprint ?? '')
      || (credential.state === 'valid' ? typeof credential.passwordHash !== 'string' : credential.passwordHash !== null))) {
    throw new HttpError(400, 'invalid_bulk_credentials', 'Prepared User credentials do not match the uploaded rows.');
  }
  await client.query(`SELECT master_bulk_store_user_credential($1,row_id,revision,state,decode(fingerprint,'hex'),password_hash)
    FROM unnest($2::uuid[],$3::integer[],$4::text[],$5::text[],$6::text[]) AS credentials(row_id,revision,state,fingerprint,password_hash)`,
  [batchId, rows.map(row => row.id), rows.map(row => row.revision), credentials.map(credential => credential.state),
    credentials.map(credential => credential.fingerprint), credentials.map(credential => credential.passwordHash)]);
}

export async function loadUserBulkCredentialStates(client, identity, batchId, rows) {
  requirePermission(identity, 'users.manage');
  if (!rows.length) return new Map();
  const result = await client.query(`SELECT credential.row_id AS "rowId",credential.state,credential.fingerprint
    FROM master_bulk_user_credential_states credential JOIN unnest($3::uuid[],$4::integer[]) AS requested(row_id,revision)
      ON requested.row_id=credential.row_id AND requested.revision=credential.input_revision
    WHERE credential.organization_id=$1 AND credential.batch_id=$2`,
  [identity.organization_id, batchId, rows.map(row => row.id), rows.map(row => row.revision)]);
  return new Map(result.rows.map(({ rowId, ...credential }) => [rowId, credential]));
}
