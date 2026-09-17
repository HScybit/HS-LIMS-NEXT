import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { lookupSourceInput, lookupSourceLineLimit } from './lookup-source-input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some(permission => ['masters.read', 'masters.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view lookup source observations.');
  }
}

export async function loadMasterFieldLookupOptions(kind, client, identity, input) {
  if (!['product', 'parameter', 'method', 'customer'].includes(kind)) throw new TypeError('Unsupported lookup field master.');
  requireRead(identity); fieldsOnly(input, ['sourceId', 'revision', 'knownOrganizationId']);
  if (kind === 'customer' && !(await client.query("SELECT masters_can_read_party('customer') AS allowed")).rows[0]?.allowed) {
    throw new HttpError(403, 'customer_module_access_required', 'Customer module access is required.');
  }
  const sourceId = uuid(input.sourceId, 'Lookup source').toLowerCase();
  if (input.revision !== undefined) integer(input.revision, 'Known lookup revision', 1, 2_147_483_647);
  const knownOrganizationId = input.knownOrganizationId === undefined ? null : uuid(input.knownOrganizationId, 'Known lookup organization').toLowerCase();
  const context = { organizationId: identity.organization_id, sourceId };
  const current = (await client.query(`SELECT source.revision,source.line_count AS "headLineCount",observation.line_count AS "lineCount"
    FROM custom_field_lookup_sources source LEFT JOIN custom_field_lookup_versions observation
      ON observation.organization_id=source.organization_id AND observation.source_id=source.id AND observation.revision=source.revision
    WHERE source.organization_id=$1 AND source.id=$2 AND EXISTS (
      SELECT 1 FROM custom_field_definitions definition WHERE definition.organization_id=source.organization_id
        AND definition.associated_with=$3 AND definition.active AND definition.field_type='lookup' AND definition.lookup_source_id=source.id
    )`, [identity.organization_id, sourceId, kind === 'method' ? 'method_of_analysis' : kind])).rows[0];
  if (!current) return { ...context, revision: null, options: [] };
  const incomplete = () => new HttpError(409, 'incomplete_master_lookup', 'Lookup choices changed. Reload before continuing.');
  if (!Number.isInteger(current.lineCount) || current.lineCount < 0 || current.lineCount > lookupSourceLineLimit || current.lineCount !== current.headLineCount) throw incomplete();
  if (knownOrganizationId === identity.organization_id && current.revision === input.revision) return { ...context, revision: current.revision, unchanged: true };
  const rows = (await client.query(`SELECT original_line_id AS value,position,label_kind AS kind,
    label_text AS text,label_number AS number,label_boolean AS boolean FROM custom_field_lookup_lines
    WHERE organization_id=$1 AND source_id=$2 AND revision=$3 ORDER BY position LIMIT $4`,
  [identity.organization_id, sourceId, current.revision, lookupSourceLineLimit + 1])).rows;
  if (rows.length !== current.lineCount || rows.some((row, index) => row.position !== index || !['text', 'number', 'boolean'].includes(row.kind) || row[row.kind] === null)) throw incomplete();
  return { ...context, revision: current.revision, options: rows.map(row => ({ value: row.value, label: row[row.kind] })) };
}

export async function loadLookupSourceObservation(client, identity, id, { atRevision } = {}) {
  requireRead(identity); uuid(id, 'Lookup source');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const record = (await client.query(`SELECT source.id,source.source_system AS "sourceSystem",source.original_source_id AS "sourceId",
    version.revision,version.previous_revision AS "previousRevision",version.request_id AS "requestId",version.name,
    version.line_count AS "lineCount",version.observed_by AS "observedBy",version.observed_at AS "observedAt"
    FROM custom_field_lookup_sources source JOIN custom_field_lookup_versions version
      ON version.organization_id=source.organization_id AND version.source_id=source.id AND version.revision=${atRevision === undefined ? 'source.revision' : '$3'}
    WHERE source.organization_id=$1 AND source.id=$2`,
  atRevision === undefined ? [identity.organization_id, id] : [identity.organization_id, id, atRevision])).rows[0];
  if (!record) throw new HttpError(404, 'lookup_source_not_found', 'The lookup source observation was not found.');
  const rows = (await client.query(`SELECT original_line_id AS id,position,label_kind AS kind,label_text AS text,label_number AS number,label_boolean AS boolean
    FROM custom_field_lookup_lines WHERE organization_id=$1 AND source_id=$2 AND revision=$3 ORDER BY position LIMIT $4`,
  [identity.organization_id, id, record.revision, lookupSourceLineLimit + 1])).rows;
  if (rows.length !== record.lineCount || rows.some((line, index) => line.position !== index || !['text', 'number', 'boolean'].includes(line.kind) || line[line.kind] === null)) {
    throw new HttpError(409, 'incomplete_lookup_source', 'The lookup source observation is incomplete.');
  }
  return { ...record, lines: rows.map(line => ({ id: line.id, label: line[line.kind] })) };
}

// Internal ingestion boundary: no standalone Data Master route or editor is exposed.
export async function saveLookupSourceObservation(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = lookupSourceInput(value);
  // Serialize with captures and revalidate the actual observer after every wait, including retries.
  try { await client.query('SELECT masters_lock_lookup_observer()'); }
  catch (error) {
    if (error.constraint === 'custom_lookup_session_required') throw new HttpError(403, 'forbidden', 'Your lookup management session is no longer available.');
    throw error;
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-lookup-request:'||$1::text||':'||$2::text,0))", [identity.organization_id, input.requestId]);
  const prior = (await client.query(`SELECT source_id,revision,previous_revision,observed_by FROM custom_field_lookup_versions
    WHERE organization_id=$1 AND request_id=$2`, [identity.organization_id, input.requestId])).rows[0];
  if (prior) {
    if (prior.source_id !== input.id || prior.previous_revision !== input.revision || prior.observed_by !== identity.user_id) {
      throw new HttpError(409, 'save_request_reused', 'This request was already used for another lookup observation.');
    }
    const observation = await loadLookupSourceObservation(client, identity, input.id, { atRevision: prior.revision });
    if (observation.sourceId !== input.sourceId || observation.name !== input.name || JSON.stringify(observation.lines) !== JSON.stringify(input.lines)) {
      throw new HttpError(409, 'save_request_reused', 'This request was already used for different lookup values.');
    }
    return observation;
  }
  const current = (await client.query(`SELECT revision,original_source_id FROM custom_field_lookup_sources
    WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [identity.organization_id, input.id])).rows[0];
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_lookup_source', 'The lookup source changed. Reload before importing another observation.');
  if (current && current.original_source_id !== input.sourceId) throw new HttpError(409, 'lookup_source_identity_changed', 'An observation cannot change the original source identifier.');
  try {
    const args = [identity.organization_id, input.id, input.sourceId, input.name, input.lines.length, input.requestId];
    if (!current) await client.query(`INSERT INTO custom_field_lookup_sources(organization_id,id,original_source_id,name,line_count,request_id)
      VALUES($1,$2,$3,$4,$5,$6)`, args);
    else await client.query(`UPDATE custom_field_lookup_sources SET name=$4,line_count=$5,request_id=$6,revision=revision+1,updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=$2 AND original_source_id=$3`, args);
    if (input.lines.length) await client.query(`INSERT INTO custom_field_lookup_lines(organization_id,source_id,revision,original_line_id,position,label_kind,label_text,label_number,label_boolean)
      SELECT $1,$2,$3,id,position-1,kind,text,number,boolean FROM unnest($4::text[],$5::text[],$6::text[],$7::double precision[],$8::boolean[])
      WITH ORDINALITY AS line(id,kind,text,number,boolean,position)`,
    [identity.organization_id, input.id, input.revision + 1, input.lines.map(line => line.id),
      input.lines.map(line => typeof line.label === 'string' ? 'text' : typeof line.label),
      input.lines.map(line => typeof line.label === 'string' ? line.label : null), input.lines.map(line => typeof line.label === 'number' ? line.label : null),
      input.lines.map(line => typeof line.label === 'boolean' ? line.label : null)]);
  } catch (error) {
    if (error.constraint === 'custom_lookup_source_pk') throw new HttpError(409, 'stale_lookup_source', 'This lookup source was already created.');
    if (error.constraint === 'custom_lookup_original_source_key') throw new HttpError(409, 'duplicate_lookup_source', 'This original source already has a native lookup mapping.');
    if (error.constraint === 'custom_lookup_request_key') throw new HttpError(409, 'save_request_reused', 'This request was already used for another lookup observation.');
    throw error;
  }
  return loadLookupSourceObservation(client, identity, input.id);
}
