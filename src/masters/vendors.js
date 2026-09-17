import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { partyCommandInput, partySaveInput } from './party-input.js';
import { partyRequestFingerprint } from './party-request.js';
import { partyContactFields, resolvePartyRelations } from './party-relations.js';
import { vendorCustomFields } from './custom-fields.js';
import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from './master-custom-field-values.js';

const columns = `revision,code,name,legal_name AS "legalName",abbreviation,tax_identifier AS "taxIdentifier",
  total_balance AS "totalBalance",active,retired,custom_field_count AS "customFieldCount",custom_fields_provided AS "customFieldsProvided"`;
const contactColumns = `contact.id,contact.name,contact.email,contact.phone,contact.is_primary AS "isPrimary"`;
const contactKeys = ['id', 'name', 'email', 'phone', 'isPrimary'];

export async function requireVendorRead(client, identity) {
  if (!identity.permission_codes?.some(code => ['masters.read', 'masters.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view Vendors.');
  if (!(await client.query("SELECT masters_can_read_party('vendor') AS allowed")).rows[0]?.allowed) throw new HttpError(403, 'vendor_module_access_required', 'Vendor module access is required.');
}

function vendorError(error) {
  if (error instanceof HttpError) return error;
  if (error.constraint === 'organization_module_access_required') return new HttpError(403, 'vendor_module_access_required', 'Vendor module access is required.');
  if (error.code === '42501') return new HttpError(403, 'forbidden', 'Your Vendor management permission changed. Reload before continuing.');
  if (error.constraint === 'vendor_not_found') return new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
  if (error.constraint === 'vendor_stale_revision') return new HttpError(409, 'stale_vendor', 'The Vendor changed. Reload before saving.');
  if (['vendor_request_reused', 'vendor_save_request_key'].includes(error.constraint)) return new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  if (error.constraint === 'vendor_in_use') return new HttpError(409, 'vendor_in_use', 'This Vendor is in use and cannot be deleted.');
  if (error.constraint === 'vendor_custom_field_unique') return new HttpError(409, 'duplicate_custom_field_value', 'A unique Custom Field value is already in use.');
  if (['vendor_custom_field_definition_set', 'vendor_custom_field_preserve'].includes(error.constraint)) return new HttpError(409, 'vendor_custom_fields_changed', 'Custom Fields changed. Reload before saving.');
  if (error.constraint === 'vendor_custom_field_required') return new HttpError(400, 'invalid_custom_field_value', 'Complete the required Custom Fields.');
  if (error.constraint?.startsWith('vendor_custom_value_')) return new HttpError(400, 'invalid_vendor_custom_field_reference', 'A Custom Field selection is no longer available.');
  if (error.constraint === 'vendors_code_key') return new HttpError(409, 'duplicate_vendor', 'The Vendor code is already in use. Use a distinct name or abbreviation.');
  if (['vendor_command_input', 'vendor_relation_input', 'vendor_relation_owner', 'vendor_primary_contact_key'].includes(error.constraint)) {
    return new HttpError(400, 'invalid_vendor', 'Check the Vendor details and contacts.');
  }
  if (['22003', '22P02'].includes(error.code)) return new HttpError(400, 'invalid_vendor_number', 'A Vendor number exceeds its supported range.');
  if (error.constraint === 'module_access_write_isolation') return new HttpError(409, 'vendor_write_isolation', 'Reload and retry this Vendor change in a new transaction.');
  return error;
}

async function readVendor(client, identity, id, atRevision) {
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT ${history ? 'vendor_id' : 'id'} AS id,${columns}
    ${history ? ',saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation,contact_count AS "contactCount"' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'vendor_versions' : 'vendors'} WHERE organization_id=$1 AND ${history ? 'vendor_id' : 'id'}=$2 ${history ? 'AND revision=$3' : ''}`,
  history ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows[0];
  if (!record) return null;
  const args = [identity.organization_id, id, record.revision];
  const contacts = (await client.query(`SELECT ${contactColumns} FROM ${history ? 'vendor_version_contacts' : 'vendor_contacts'} contact
    ${history ? '' : 'LEFT JOIN vendor_version_contacts saved ON saved.organization_id=contact.organization_id AND saved.vendor_id=contact.vendor_id AND saved.id=contact.id AND saved.revision=$3'}
    WHERE contact.organization_id=$1 AND contact.vendor_id=$2 ${history ? 'AND contact.revision=$3' : ''}
    ORDER BY ${history ? 'contact.position' : 'saved.position NULLS LAST,contact.id'}`, args)).rows;
  if (history && contacts.length !== record.contactCount) throw new HttpError(409, 'incomplete_vendor_history', 'Vendor history is incomplete.');
  const customFields = await loadMasterCustomFieldValues('vendor', client, identity, id, record.revision, record.customFieldCount);
  const customFieldTimeZone = customFields.find(field => ['date', 'date_time'].includes(field.fieldType))?.timeZone ?? null;
  return { ...record, status: record.active ? 'active' : 'inactive', contacts, ...partyContactFields(contacts), customFields, customFieldTimeZone };
}

export async function loadVendor(client, identity, vendorId, { atRevision } = {}) {
  await requireVendorRead(client, identity); const id = uuid(vendorId, 'Vendor').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const record = await readVendor(client, identity, id, atRevision);
  if (!record || atRevision === undefined && record.retired) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
  return record;
}

async function finishCapture(client) {
  await client.query('SET CONSTRAINTS vendor_custom_fields_complete,vendor_relations_complete IMMEDIATE');
  await client.query('SET CONSTRAINTS vendor_custom_fields_complete,vendor_relations_complete DEFERRED');
}

export async function saveVendor(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); const command = partyCommandInput('vendor', raw);
  try {
    await client.query('SELECT masters_require_vendor_write()');
    const existing = await readVendor(client, identity, command.id);
    if (command.revision && !existing) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
    const input = partySaveInput('vendor', raw, existing); const fingerprint = partyRequestFingerprint('vendor', raw, input);
    const prior = (await client.query('SELECT masters_vendor_prior_request($1,$2,$3,$4,$5) AS revision',
      [input.id, input.revision, input.requestId, fingerprint, input.revision ? 'update' : 'create'])).rows[0].revision;
    if (prior !== null) return loadVendor(client, identity, input.id, { atRevision: prior });
    if (input.revision && (!existing || existing.retired)) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
    if ((existing?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_vendor', 'The Vendor changed. Reload before saving.');
    const definitions = await vendorCustomFields(client, identity);
    const capture = await prepareMasterCustomFieldValues('vendor', client, identity, { definitions, entries: input.customFields,
      timeZone: input.customFieldTimeZone, previousFields: existing?.customFields ?? [] });
    const { contacts } = resolvePartyRelations('vendor', input, existing ?? {});
    const args = [input.id, input.revision, input.requestId, fingerprint, input.code, input.name, input.legalName, input.abbreviation, input.taxIdentifier,
      input.totalBalance, input.active, capture.count, capture.provided, ...contactKeys.map(key => contacts.map(contact => contact[key]))];
    const revision = (await client.query(`SELECT masters_save_vendor(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args)).rows[0].revision;
    await appendMasterCustomFieldValues('vendor', client, identity, input.id, revision, capture);
    await finishCapture(client);
    return loadVendor(client, identity, input.id, { atRevision: revision });
  } catch (error) { throw vendorError(error); }
}

export async function retireVendor(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(raw, ['id', 'requestId', 'revision']);
  const input = partyCommandInput('vendor', raw); integer(input.revision, 'Revision', 1, 2_147_483_646);
  try {
    const fingerprint = partyRequestFingerprint('vendor', raw, input);
    const revision = (await client.query('SELECT masters_retire_vendor($1,$2,$3,$4) AS revision', [input.id, input.revision, input.requestId, fingerprint])).rows[0].revision;
    await finishCapture(client);
    return { id: input.id, revision };
  } catch (error) { throw vendorError(error); }
}
