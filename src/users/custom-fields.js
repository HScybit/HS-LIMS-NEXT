import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { userCustomFields } from '../masters/custom-fields.js';
import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from '../masters/master-custom-field-values.js';
import { userProfileCommandError } from './profiles.js';
import { userCustomFieldInput, userFieldUserIds, userFieldUserSearch } from './custom-field-input.js';
import { matchesUserFieldUserOption } from './custom-field-filter.js';
import { lookupSourceLineLimit } from '../custom-fields/lookup-source-input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some(code => ['users.read', 'users.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view user fields.');
}
const errors = {
  user_custom_field_invalid_input: [400, 'invalid_user_custom_fields', 'The field capture is invalid.'],
  user_custom_field_stale: [409, 'stale_user_custom_fields', 'These user fields changed. Reload before saving.'],
  user_custom_field_request_reused: [409, 'save_request_reused', 'This save request was already used for another field capture.'],
  user_field_value_request_key: [409, 'save_request_reused', 'This save request was already used for another field capture.'],
  user_custom_field_definition_set: [409, 'user_custom_fields_changed', 'Custom Fields changed. Reload before saving.'],
  user_custom_field_limit: [409, 'custom_field_limit', 'This form supports at most 500 Custom Fields.'],
  user_custom_field_unique: [409, 'duplicate_user_custom_field', 'A unique Custom Field value is already in use.'],
  user_custom_field_required: [400, 'invalid_custom_field_value', 'Complete the required Custom Fields.'],
  user_custom_field_timezone: [400, 'invalid_custom_field_timezone', 'The capture time zone does not match its date fields.'],
  user_custom_field_complete: [409, 'incomplete_user_custom_fields', 'User Custom Field history is incomplete.'],
};
const historyColumns = `version.previous_revision AS "previousRevision",version.custom_field_count AS "customFieldCount",version.time_zone AS "customFieldTimeZone",
  version.username,version.display_name AS "displayName",version.saved_by AS "savedBy",version.saved_by_username AS "savedByUsername",
  version.saved_by_name AS "savedByName",version.saved_at AS "savedAt"`;

export async function loadUserFieldLookupOptions(client, identity, input) {
  requireRead(identity); fieldsOnly(input, ['sourceId', 'revision', 'knownOrganizationId']);
  const sourceId = uuid(input.sourceId, 'Lookup source').toLowerCase();
  if (input.revision !== undefined) integer(input.revision, 'Known lookup revision', 1, 2_147_483_647);
  const knownOrganizationId = input.knownOrganizationId === undefined ? null : uuid(input.knownOrganizationId, 'Known lookup organization').toLowerCase();
  const context = { organizationId: identity.organization_id, sourceId };
  const current = (await client.query(`SELECT revision FROM user_custom_field_lookup_lines
    WHERE organization_id=$1 AND source_id=$2 LIMIT 1`, [identity.organization_id, sourceId])).rows[0];
  if (!current) return { ...context, revision: null, options: [] };
  if (knownOrganizationId === identity.organization_id && current.revision === input.revision) return { ...context, revision: current.revision, unchanged: true };
  const rows = (await client.query(`SELECT revision,original_line_id AS value,position,label_kind AS kind,
    label_text AS text,label_number AS number,label_boolean AS boolean FROM user_custom_field_lookup_lines
    WHERE organization_id=$1 AND source_id=$2 AND revision=$3 ORDER BY position LIMIT $4`,
  [identity.organization_id, sourceId, current.revision, lookupSourceLineLimit + 1])).rows;
  if (!rows.length || rows.length > lookupSourceLineLimit || rows.some((row, index) => row.position !== index
    || row.revision !== current.revision || !['text', 'number', 'boolean'].includes(row.kind) || row[row.kind] === null)) {
    throw new HttpError(409, 'incomplete_user_lookup', 'Lookup choices changed. Reload before continuing.');
  }
  return { ...context, revision: current.revision, options: rows.map(row => ({ value: row.value, label: row[row.kind] })) };
}

export async function loadUserFieldUserLabels(client, identity, input) {
  requireRead(identity); const ids = userFieldUserIds(input);
  if (!ids.length) return { rows: [] };
  const result = await client.query(`SELECT person.id,person.display_name AS name
    FROM unnest($2::uuid[]) WITH ORDINALITY AS requested(id,position)
    JOIN user_directory person ON person.organization_id=$1 AND person.id=requested.id ORDER BY requested.position`, [identity.organization_id, ids]);
  return { rows: result.rows };
}

export async function loadUserFieldUserOptions(client, identity, input) {
  requireRead(identity); const search = userFieldUserSearch(input);
  const rows = []; let afterId = null;
  while (true) {
    // Keyset batches keep the exact source filter without loading the whole directory into memory.
    const batch = (await client.query(`SELECT person.id,person.display_name AS name FROM user_directory person
      WHERE person.organization_id=$1 ${afterId ? 'AND person.id>$2' : ''} ORDER BY person.id LIMIT 501`,
    afterId ? [identity.organization_id, afterId] : [identity.organization_id])).rows;
    for (const person of batch.slice(0, 500)) {
      if (matchesUserFieldUserOption(person, search)) rows.push(person);
      if (rows.length > 50) return { rows: rows.slice(0, 50), hasMore: true };
    }
    if (batch.length <= 500) return { rows, hasMore: false };
    afterId = batch[499].id;
  }
}

export async function loadUserCustomFields(client, identity, userId, { atRevision } = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Capture revision', 1, 2_147_483_647);
  const row = (await client.query(`SELECT head.subject_user_id AS id,head.revision AS "currentRevision",version.revision,${historyColumns}
    FROM user_field_capture_heads head LEFT JOIN user_field_capture_history version ON version.organization_id=head.organization_id
      AND version.subject_user_id=head.subject_user_id AND version.revision=${atRevision === undefined ? 'head.revision' : '$3'}
    WHERE head.organization_id=$1 AND head.subject_user_id=$2`,
  atRevision === undefined ? [identity.organization_id, id] : [identity.organization_id, id, atRevision])).rows[0];
  if (!row) throw new HttpError(404, 'user_not_found', 'User was not found.');
  const { currentRevision, ...record } = row;
  if (record.revision === null) {
    if (atRevision !== undefined) throw new HttpError(404, 'user_field_capture_not_found', 'Field capture was not found.');
    if (currentRevision !== 0) throw new HttpError(409, 'incomplete_user_custom_fields', 'User Custom Field history is incomplete.');
    return { ...record, revision: 0, recorded: false, customFieldCount: 0, customFieldTimeZone: null, customFields: [] };
  }
  return { ...record, recorded: true, customFields: await loadMasterCustomFieldValues('user', client, identity, id, record.revision, record.customFieldCount) };
}

export async function saveUserCustomFields(client, identity, userId, value) {
  requirePermission(identity, 'users.manage'); const input = userCustomFieldInput(userId, value);
  try {
    const result = (await client.query('SELECT * FROM users_begin_field_capture($1,$2,$3,$4,$5)',
      [input.id, input.revision, input.requestId, input.customFields.length, input.customFieldTimeZone])).rows[0];
    if (result.replayed) {
      const fields = await loadMasterCustomFieldValues('user', client, identity, input.id, result.saved_revision, input.customFields.length);
      const raw = fields.map(({ fieldId, fieldRevision, value }) => ({ fieldId, fieldRevision, value }));
      if (JSON.stringify(raw) !== JSON.stringify(input.customFields)) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different field values.');
      return { id: input.id, revision: result.saved_revision };
    }
    const definitions = await userCustomFields(client, identity);
    const previousFields = await loadMasterCustomFieldValues('user', client, identity, input.id, input.revision, result.previous_field_count);
    const capture = await prepareMasterCustomFieldValues('user', client, identity, { definitions, entries: input.customFields, timeZone: input.customFieldTimeZone, previousFields });
    await appendMasterCustomFieldValues('user', client, identity, input.id, result.saved_revision, capture);
    await client.query('SET CONSTRAINTS user_custom_fields_complete,membership_custom_field_version_required IMMEDIATE');
    await client.query('SET CONSTRAINTS user_custom_fields_complete,membership_custom_field_version_required DEFERRED');
    return { id: input.id, revision: result.saved_revision };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    if (['user_custom_value_option', 'user_custom_value_option_fk', 'user_custom_value_user', 'user_custom_value_user_fk',
      'user_custom_value_attachment', 'user_custom_value_attachment_fk', 'user_custom_value_lookup', 'user_custom_value_lookup_fk',
      'user_custom_value_lookup_reference'].includes(error.constraint)) {
      throw new HttpError(400, 'invalid_user_custom_field_reference', 'A Custom Field selection is no longer available.');
    }
    throw userProfileCommandError(error);
  }
}

export async function loadUserCustomFieldHistory(client, identity, userId, input = {}) {
  requireRead(identity); const id = uuid(userId, 'User').toLowerCase(); fieldsOnly(input, ['limit', 'beforeRevision']);
  const limit = input.limit === undefined ? 25 : integer(input.limit, 'History page size', 1, 100);
  const before = input.beforeRevision === undefined ? null : integer(input.beforeRevision, 'History cursor', 1, 2_147_483_647);
  if (!(await client.query('SELECT 1 FROM user_field_capture_heads WHERE organization_id=$1 AND subject_user_id=$2', [identity.organization_id, id])).rowCount) {
    throw new HttpError(404, 'user_not_found', 'User was not found.');
  }
  const rows = (await client.query(`SELECT version.revision,${historyColumns} FROM user_field_capture_history version
    WHERE version.organization_id=$1 AND version.subject_user_id=$2 AND ($3::integer IS NULL OR version.revision<$3)
    ORDER BY version.revision DESC LIMIT $4`, [identity.organization_id, id, before, limit + 1])).rows;
  return { rows: rows.slice(0, limit), nextBeforeRevision: rows.length > limit ? rows[limit - 1].revision : null };
}
