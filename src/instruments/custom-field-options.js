import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { lookupSourceLineLimit } from '../custom-fields/lookup-source-input.js';
import { requireInstrumentRead } from './core.js';

export async function instrumentFieldLookupOptions(client, identity, input) {
  await requireInstrumentRead(client, identity); fieldsOnly(input, ['sourceId', 'revision', 'knownOrganizationId']);
  const sourceId = uuid(input.sourceId, 'Lookup source').toLowerCase();
  if (input.revision !== undefined) integer(input.revision, 'Known lookup revision', 1, 2_147_483_647);
  const knownOrganizationId = input.knownOrganizationId === undefined ? null : uuid(input.knownOrganizationId, 'Known lookup organization').toLowerCase();
  const context = { organizationId: identity.organization_id, sourceId };
  const current = (await client.query(`SELECT revision,line_count AS "headLineCount",observed_line_count AS "lineCount"
    FROM instrument_custom_field_lookup_sources WHERE organization_id=$1 AND id=$2`, [identity.organization_id, sourceId])).rows[0];
  if (!current) return { ...context, revision: null, options: [] };
  const incomplete = () => new HttpError(409, 'incomplete_instrument_lookup', 'Lookup choices changed. Reload before continuing.');
  if (!Number.isInteger(current.lineCount) || current.lineCount < 0 || current.lineCount > lookupSourceLineLimit || current.lineCount !== current.headLineCount) throw incomplete();
  if (knownOrganizationId === identity.organization_id && current.revision === input.revision) return { ...context, revision: current.revision, unchanged: true };
  const rows = (await client.query(`SELECT original_line_id AS value,position,label_kind AS kind,label_text AS text,label_number AS number,label_boolean AS boolean
    FROM instrument_custom_field_lookup_lines WHERE organization_id=$1 AND source_id=$2 AND revision=$3 ORDER BY position LIMIT $4`,
  [identity.organization_id, sourceId, current.revision, lookupSourceLineLimit + 1])).rows;
  if (rows.length !== current.lineCount || rows.some((row, index) => row.position !== index || !['text', 'number', 'boolean'].includes(row.kind) || row[row.kind] === null)) throw incomplete();
  return { ...context, revision: current.revision, options: rows.map(row => ({ value: row.value, label: row[row.kind] })) };
}

export async function instrumentFieldUserOptions(client, identity, input = {}) {
  await requireInstrumentRead(client, identity); fieldsOnly(input, ['search']);
  const search = text(input.search, 'User search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_input', 'User search must contain valid text.');
  const { matchesUserFieldUserOption } = await import('../users/custom-field-filter.js');
  const rows = []; let after = null;
  while (true) {
    const batch = (await client.query(`SELECT user_id AS id,display_name AS name FROM instrument_access_user_labels
      WHERE organization_id=$1 ${after ? 'AND (display_name,user_id)>($2,$3::uuid)' : ''}
      ORDER BY display_name,user_id LIMIT 501`, after ? [identity.organization_id, after.name, after.id] : [identity.organization_id])).rows;
    for (const person of batch.slice(0, 500)) {
      if (matchesUserFieldUserOption(person, search)) rows.push(person);
      if (rows.length > 100) return { rows: rows.slice(0, 100), hasMore: true };
    }
    if (batch.length <= 500) return { rows, hasMore: false };
    after = batch[499];
  }
}
