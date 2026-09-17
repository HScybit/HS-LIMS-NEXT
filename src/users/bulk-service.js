import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { requirePermission } from '../templates/input.js';
import { bindUserBulkHeaders } from './bulk-input.js';
import { userBulkAliases, userBulkRowCommand } from './bulk-row.js';
import { loadUserBulkCredentialStates } from './bulk-store.js';
import { userCreationCommandError } from './create.js';

const invalid = message => new HttpError(422, 'invalid_user_bulk_row', message);
const kinds = { defaultRoleId: 'roles', businessUnitId: 'businessUnits', laboratoryId: 'laboratories' };

function referenceResolver(client, identity) {
  const cache = new Map();
  return async (field, values) => {
    if (!Object.hasOwn(kinds, field) || values.length !== 1) throw invalid('Choose a single User profile reference.');
    const value = values[0].toLowerCase(); const key = `${field}:${value}`;
    if (cache.has(key)) return cache.get(key);
    const rows = (await client.query(`SELECT id,name FROM user_profile_references WHERE organization_id=$1 AND kind=$2 AND active
      AND (lower(id::text)=$3 OR lower(name)=$3) ORDER BY (lower(id::text)=$3) DESC,id LIMIT 2`, [identity.organization_id, kinds[field], value])).rows;
    const exact = rows.find(row => row.id === value);
    if (!exact && rows.length !== 1) throw invalid(`${kinds[field]}: Choose an active record by its identifier or unique name.`);
    const result = [(exact ?? rows[0]).id]; cache.set(key, result); return result;
  };
}

export async function userBulkContext(client, identity, batch, requestedRows) {
  requirePermission(identity, 'users.manage'); const columns = bindUserBulkHeaders(batch.columns.map(column => column.header));
  const identityColumns = columns.filter(column => ['username', 'email'].includes(column.fieldName));
  const cells = (await client.query(`SELECT row.id,cell.column_number AS "columnNumber",cell.value_kind AS kind,
    cell.text_value AS "textValue",cell.number_value AS "numberValue",cell.boolean_value AS "booleanValue",cell.date_value AS "dateValue"
    FROM master_bulk_rows row JOIN master_bulk_cells cell ON cell.organization_id=row.organization_id AND cell.batch_id=row.batch_id
      AND cell.row_id=row.id AND cell.revision=row.revision
    WHERE row.organization_id=$1 AND row.batch_id=$2 AND cell.column_number=ANY($3::integer[])`,
  [identity.organization_id, batch.id, identityColumns.map(column => column.columnNumber)])).rows;
  const rows = new Map();
  for (const cell of cells) {
    if (!rows.has(cell.id)) rows.set(cell.id, { id: cell.id, values: [] });
    rows.get(cell.id).values[cell.columnNumber - 1] = cell.kind === 'missing' ? '' : cell[`${cell.kind}Value`];
  }
  const aliases = userBulkAliases([...rows.values()], columns);
  const existing = new Set((await client.query('SELECT alias FROM master_bulk_user_aliases($1::text[])', [[...aliases.keys()]])).rows.map(row => row.alias));
  const credentials = await loadUserBulkCredentialStates(client, identity, batch.id, requestedRows);
  return { columns, aliases, existing, credentials, resolve: referenceResolver(client, identity),
    definitionHash: createHash('sha256').update(JSON.stringify(columns)).digest('hex'), store: { save: createUserBulkRecord } };
}

export async function prepareUserBulkRow(batch, context, row, reviewId, expected) {
  const candidateId = expected?.candidate_id ?? randomUUID();
  const prepared = await userBulkRowCommand({ columns: context.columns, row, credential: context.credentials.get(row.id),
    id: candidateId, requestId: reviewId, resolve: context.resolve });
  for (const value of [prepared.command.username, prepared.command.email]) {
    const alias = value.toLowerCase();
    if ((context.aliases.get(alias)?.size ?? 0) > 1) throw invalid('A username or email appears in more than one uploaded User row. Each sign-in identifier must be unique.');
    if (context.existing.has(alias)) throw new HttpError(409, 'sign_in_identifier_taken', 'A username or email is already in use. User uploads create new accounts only.');
  }
  const commandHash = createHash('sha256').update(JSON.stringify(prepared)).digest('hex');
  if (expected && (expected.command_sha256 !== commandHash || expected.definitions_sha256 !== context.definitionHash || expected.expected_revision !== 0)) {
    throw new HttpError(409, 'stale_bulk_review', 'A User input or resolved reference changed. Validate the row again before processing.');
  }
  return { command: { ...prepared.command, bulkInput: { batchId: batch.id, rowId: row.id, revision: row.revision } },
    commandHash, candidateId, expectedRevision: 0, definitionHash: context.definitionHash, operation: 'create' };
}

async function createUserBulkRecord(client, identity, command) {
  requirePermission(identity, 'users.manage');
  const { bulkInput } = command;
  try {
    const result = await client.query('SELECT * FROM master_bulk_create_user($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [bulkInput.batchId, bulkInput.rowId, bulkInput.revision, command.requestId, command.username, command.email, command.displayName,
        command.phone ?? null, command.designation ?? null, command.businessUnitId ?? null, command.defaultRoleId, command.laboratoryId]);
    return { id: result.rows[0].id, revision: result.rows[0].profile_revision };
  } catch (error) {
    if (error.constraint === 'master_bulk_user_review') throw invalid('The prepared User account is no longer valid. Validate it again.');
    throw userCreationCommandError(error);
  }
}
