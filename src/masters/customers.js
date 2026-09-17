import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { partyCommandInput, partySaveInput } from './party-input.js';
import { partyRequestFingerprint } from './party-request.js';
import { customerAddressFields, partyContactFields, resolvePartyRelations } from './party-relations.js';
import { customerCustomFields } from './custom-fields.js';
import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from './master-custom-field-values.js';

const columns = `revision,code,name,legal_name AS "legalName",abbreviation,tax_identifier AS "taxIdentifier",credit_days AS "creditDays",
  total_balance AS "totalBalance",default_invoice_notes AS "defaultInvoiceNotes",feedback_applicable AS "feedbackApplicable",
  igst_percent AS "igstPercent",sgst_percent AS "sgstPercent",cgst_percent AS "cgstPercent",discount_percent AS "discountPercent",is_kaleen_bandhu AS "isKaleenBandhu",
  active,retired,custom_field_count AS "customFieldCount",custom_fields_provided AS "customFieldsProvided"`;
const addressColumns = `address.id,address.address_type AS "addressType",address.attention_to AS "attentionTo",address.line_1 AS "line1",address.line_2 AS "line2",
  address.city,address.state,address.postal_code AS "postalCode",address.country_code AS "countryCode",address.freeform_address AS "freeformAddress",address.is_default AS "isDefault"`;
const contactColumns = `contact.id,contact.name,contact.email,contact.phone,contact.designation,contact.is_primary AS "isPrimary"`;
const addressKeys = ['id', 'addressType', 'attentionTo', 'line1', 'line2', 'city', 'state', 'postalCode', 'countryCode', 'freeformAddress', 'isDefault'];
const contactKeys = ['id', 'name', 'email', 'phone', 'designation', 'isPrimary'];

async function requireRead(client, identity) {
  if (!identity.permission_codes?.some(code => ['masters.read', 'masters.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view Customers.');
  if (!(await client.query("SELECT masters_can_read_party('customer') AS allowed")).rows[0]?.allowed) throw new HttpError(403, 'customer_module_access_required', 'Customer module access is required.');
}

function customerError(error) {
  if (error instanceof HttpError) return error;
  if (error.constraint === 'organization_module_access_required') return new HttpError(403, 'customer_module_access_required', 'Customer module access is required.');
  if (error.code === '42501') return new HttpError(403, 'forbidden', 'Your Customer management permission changed. Reload before continuing.');
  if (error.constraint === 'customer_not_found') return new HttpError(404, 'customer_not_found', 'Customer was not found.');
  if (error.constraint === 'customer_stale_revision') return new HttpError(409, 'stale_customer', 'The Customer changed. Reload before saving.');
  if (['customer_request_reused', 'customer_save_request_key'].includes(error.constraint)) return new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  if (error.constraint === 'customer_in_use') return new HttpError(409, 'customer_in_use', 'This Customer is in use and cannot be deleted.');
  if (error.constraint === 'customer_custom_field_unique') return new HttpError(409, 'duplicate_custom_field_value', 'A unique Custom Field value is already in use.');
  if (['customer_custom_field_definition_set', 'customer_custom_field_preserve'].includes(error.constraint)) return new HttpError(409, 'customer_custom_fields_changed', 'Custom Fields changed. Reload before saving.');
  if (error.constraint === 'customer_custom_field_required') return new HttpError(400, 'invalid_custom_field_value', 'Complete the required Custom Fields.');
  if (error.constraint?.startsWith('customer_custom_value_')) return new HttpError(400, 'invalid_customer_custom_field_reference', 'A Custom Field selection is no longer available.');
  if (error.constraint === 'customers_code_key') return new HttpError(409, 'duplicate_customer', 'The Customer code is already in use. Use a distinct name or abbreviation.');
  if (['customer_command_input', 'customer_relation_input', 'customer_relation_owner', 'customer_default_address_key', 'customer_primary_contact_key'].includes(error.constraint)) {
    return new HttpError(400, 'invalid_customer', 'Check the Customer details, addresses and contacts.');
  }
  if (['22003', '22P02'].includes(error.code)) return new HttpError(400, 'invalid_customer_number', 'A Customer number exceeds its supported range.');
  if (error.constraint === 'module_access_write_isolation') return new HttpError(409, 'customer_write_isolation', 'Reload and retry this Customer change in a new transaction.');
  return error;
}

async function readCustomer(client, identity, id, atRevision) {
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT ${history ? 'customer_id' : 'id'} AS id,${columns}
    ${history ? ',saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation,save_source AS "saveSource",address_count AS "addressCount",contact_count AS "contactCount"' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'customer_versions' : 'customers'} WHERE organization_id=$1 AND ${history ? 'customer_id' : 'id'}=$2 ${history ? 'AND revision=$3' : ''}`,
  history ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows[0];
  if (!record) return null;
  const args = [identity.organization_id, id, record.revision];
  const addresses = (await client.query(`SELECT ${addressColumns} FROM ${history ? 'customer_version_addresses' : 'customer_addresses'} address
    ${history ? '' : 'LEFT JOIN customer_version_addresses saved ON saved.organization_id=address.organization_id AND saved.customer_id=address.customer_id AND saved.id=address.id AND saved.revision=$3'}
    WHERE address.organization_id=$1 AND address.customer_id=$2 ${history ? 'AND address.revision=$3' : ''}
    ORDER BY ${history ? 'address.position' : 'saved.position NULLS LAST,address.id'}`, args)).rows;
  const contacts = (await client.query(`SELECT ${contactColumns} FROM ${history ? 'customer_version_contacts' : 'customer_contacts'} contact
    ${history ? '' : 'LEFT JOIN customer_version_contacts saved ON saved.organization_id=contact.organization_id AND saved.customer_id=contact.customer_id AND saved.id=contact.id AND saved.revision=$3'}
    WHERE contact.organization_id=$1 AND contact.customer_id=$2 ${history ? 'AND contact.revision=$3' : ''}
    ORDER BY ${history ? 'contact.position' : 'saved.position NULLS LAST,contact.id'}`, args)).rows;
  if (history && (addresses.length !== record.addressCount || contacts.length !== record.contactCount)) throw new HttpError(409, 'incomplete_customer_history', 'Customer history is incomplete.');
  const customFields = await loadMasterCustomFieldValues('customer', client, identity, id, record.revision, record.customFieldCount);
  const customFieldTimeZone = customFields.find(field => ['date', 'date_time'].includes(field.fieldType))?.timeZone ?? null;
  return { ...record, status: record.active ? 'active' : 'inactive', addresses, contacts, ...customerAddressFields(addresses), ...partyContactFields(contacts), customFields, customFieldTimeZone };
}

export async function loadCustomer(client, identity, customerId, { atRevision } = {}) {
  await requireRead(client, identity); const id = uuid(customerId, 'Customer').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const record = await readCustomer(client, identity, id, atRevision);
  if (!record || atRevision === undefined && record.retired) throw new HttpError(404, 'customer_not_found', 'Customer was not found.');
  return record;
}

async function finishCapture(client) {
  await client.query('SET CONSTRAINTS customer_custom_fields_complete,customer_relations_complete IMMEDIATE');
  await client.query('SET CONSTRAINTS customer_custom_fields_complete,customer_relations_complete DEFERRED');
}

export async function saveCustomer(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); const command = partyCommandInput('customer', raw);
  try {
    await client.query('SELECT masters_require_customer_write()');
    const existing = await readCustomer(client, identity, command.id);
    if (command.revision && !existing) throw new HttpError(404, 'customer_not_found', 'Customer was not found.');
    const input = partySaveInput('customer', raw, existing); const fingerprint = partyRequestFingerprint('customer', raw, input);
    const prior = (await client.query('SELECT masters_customer_prior_request($1,$2,$3,$4,$5) AS revision',
      [input.id, input.revision, input.requestId, fingerprint, input.revision ? 'update' : 'create'])).rows[0].revision;
    if (prior !== null) return loadCustomer(client, identity, input.id, { atRevision: prior });
    if (input.revision && (!existing || existing.retired)) throw new HttpError(404, 'customer_not_found', 'Customer was not found.');
    if ((existing?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_customer', 'The Customer changed. Reload before saving.');
    const definitions = await customerCustomFields(client, identity);
    const capture = await prepareMasterCustomFieldValues('customer', client, identity, { definitions, entries: input.customFields,
      timeZone: input.customFieldTimeZone, previousFields: existing?.customFields ?? [] });
    const { addresses, contacts } = resolvePartyRelations('customer', input, existing ?? {});
    const args = [input.id, input.revision, input.requestId, fingerprint, input.code, input.name, input.legalName, input.abbreviation, input.taxIdentifier,
      input.creditDays, input.totalBalance, input.defaultInvoiceNotes, input.feedbackApplicable, input.igstPercent, input.sgstPercent, input.cgstPercent,
      input.discountPercent, input.isKaleenBandhu, input.active, capture.count, capture.provided,
      ...addressKeys.map(key => addresses.map(address => address[key])), ...contactKeys.map(key => contacts.map(contact => contact[key]))];
    const revision = (await client.query(`SELECT masters_save_customer(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args)).rows[0].revision;
    await appendMasterCustomFieldValues('customer', client, identity, input.id, revision, capture);
    await finishCapture(client);
    return loadCustomer(client, identity, input.id, { atRevision: revision });
  } catch (error) { throw customerError(error); }
}

export async function retireCustomer(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(raw, ['id', 'requestId', 'revision']);
  const input = partyCommandInput('customer', raw); integer(input.revision, 'Revision', 1, 2_147_483_646);
  try {
    const fingerprint = partyRequestFingerprint('customer', raw, input);
    const revision = (await client.query('SELECT masters_retire_customer($1,$2,$3,$4) AS revision', [input.id, input.revision, input.requestId, fingerprint])).rows[0].revision;
    await finishCapture(client);
    return { id: input.id, revision };
  } catch (error) { throw customerError(error); }
}
