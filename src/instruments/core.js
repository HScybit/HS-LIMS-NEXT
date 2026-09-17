import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { instrumentCommandInput, instrumentCoreFields, instrumentCoreInput, instrumentRequestFingerprint } from './input.js';
import { instrumentCustomFields } from '../masters/custom-fields.js';
import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from '../masters/master-custom-field-values.js';

const fields = `item.code,item.name,item.description,item.laboratory_id AS "laboratoryId",item.make,item.model_name AS "modelName",item.serial_number AS "serialNumber",
  item.date_of_installation::text AS "dateOfInstallation",item.calibration_agency AS "calibrationAgency",item.calibrated,item.cost_of_equipment AS "costOfEquipment",
  item.purchase_file_id AS "purchaseFileId",item.current_location AS "currentLocation",item.manufacturer_supplier AS "manufacturerSupplier",item.active,item.retired,item.status,item.current_status AS "currentStatus"`;
const serviceColumns = `id,position,service_definition_id AS "serviceDefinitionId",service_definition_revision AS "serviceDefinitionRevision",service_code AS "serviceCode",service_label AS "serviceLabel",
  template_id AS "templateId",workflow_id AS "workflowId",template_name AS "templateName",workflow_name AS "workflowName",reminder_before_days AS "reminderBeforeDays",
  frequency_days AS "frequencyDays",last_performed_on::text AS "lastPerformedOn",reminder_frequency_days AS "reminderFrequencyDays",next_reminder_on::text AS "nextReminderOn",active,role_count AS "roleCount"`;

export async function requireInstrumentRead(client, identity) {
  if (!identity.permission_codes?.some(code => ['instruments.read', 'instruments.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view Instruments.');
  if (!(await client.query('SELECT instruments_can_read(NULL) AS allowed')).rows[0]?.allowed) throw new HttpError(403, 'instrument_module_access_required', 'Instrument module access is required.');
}

export function instrumentError(error) {
  if (error instanceof HttpError) return error;
  if (error.constraint === 'organization_module_access_required') return new HttpError(403, 'instrument_module_access_required', 'Instrument module access is required.');
  if (error.code === '42501') return new HttpError(403, 'forbidden', 'Your Instrument management access changed. Reload before continuing.');
  const messages = {
    instrument_not_found: [404, 'instrument_not_found', 'Instrument was not found.'],
    instrument_in_use: [409, 'instrument_in_use', 'This Instrument is in use and cannot be deleted.'],
    instrument_stale_revision: [409, 'stale_instrument', 'The Instrument changed. Reload before saving.'],
    instrument_request_reused: [409, 'save_request_reused', 'This request was already used for another Instrument change.'],
    instrument_save_request_key: [409, 'save_request_reused', 'This request was already used for another Instrument change.'],
    instruments_code_key: [409, 'duplicate_instrument_code', 'The unique key is already used by another Instrument.'],
    instrument_pk: [409, 'instrument_exists', 'This Instrument identifier is already in use.'],
    instrument_service_reference: [400, 'invalid_instrument_service_reference', 'Select configured active services and their Instrument templates and workflows.'],
    instrument_service_identity: [400, 'invalid_instrument_service_identity', 'A service configuration identity cannot be used for a different service type.'],
    instrument_reference: [400, 'invalid_instrument_reference', 'Select references from this organization.'],
    instrument_command_input: [400, 'invalid_instrument', 'Check the Instrument details and service configurations.'],
    instrument_values: [400, 'invalid_instrument', 'Check the Instrument details.'],
    instrument_custom_field_unique: [409, 'duplicate_custom_field_value', 'A unique Custom Field value is already in use.'],
    instrument_custom_field_definition_set: [409, 'instrument_custom_fields_changed', 'Custom Fields changed. Reload before saving.'],
    instrument_custom_field_preserve: [409, 'instrument_custom_fields_changed', 'Custom Fields changed. Reload before saving.'],
    instrument_custom_field_required: [400, 'invalid_custom_field_value', 'Complete the required Custom Fields.'],
    instrument_service_values: [400, 'invalid_instrument_service', 'Check the service dates, frequency, reminder roles, template and workflow.'],
    module_access_write_isolation: [409, 'instrument_write_isolation', 'Retry this Instrument change in a new transaction.'],
  };
  if (messages[error.constraint]) return new HttpError(...messages[error.constraint]);
  if (error.constraint?.startsWith('instrument_custom_value_')) return new HttpError(400, 'invalid_instrument_custom_field_reference', 'A Custom Field selection is no longer available.');
  if (error.code === '23503') return new HttpError(400, 'invalid_instrument_reference', 'Select references from this organization.');
  if (['22003', '22P02'].includes(error.code)) return new HttpError(400, 'invalid_instrument_number', 'An Instrument number exceeds its supported range.');
  return error;
}

async function readCore(client, identity, id, atRevision) {
  const historical = atRevision !== undefined;
  const item = (await client.query(`SELECT ${historical ? 'item.instrument_id' : 'item.id'} AS id,item.revision,${fields},
    item.custom_field_count AS "customFieldCount",item.custom_fields_provided AS "customFieldsProvided",
    version.user_count AS "userCount",version.service_count AS "serviceCount",version.users_provided AS "usersProvided",version.services_provided AS "servicesProvided",
    version.saved_at AS "savedAt",version.saved_by AS "savedBy",version.previous_revision AS "previousRevision",version.operation,
    ${historical ? 'item.laboratory_name' : 'coalesce(laboratory.name,version.laboratory_name)'} AS "laboratoryName"
    ${historical ? '' : ',item.created_at AS "createdAt",item.updated_at AS "updatedAt"'}
    FROM ${historical ? 'instrument_versions' : 'instruments'} item JOIN instrument_versions version ON version.organization_id=item.organization_id
      AND version.instrument_id=item.${historical ? 'instrument_id' : 'id'} AND version.revision=item.revision
    ${historical ? '' : 'LEFT JOIN instrument_laboratory_catalog laboratory ON laboratory.organization_id=item.organization_id AND laboratory.id=item.laboratory_id'}
    WHERE item.organization_id=$1 AND item.${historical ? 'instrument_id' : 'id'}=$2 ${historical ? 'AND item.revision=$3' : ''}`,
  historical ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows[0];
  if (!item) return null;
  const args = [identity.organization_id, id, item.revision];
  const allowedUsers = (await client.query(`SELECT selection.user_id AS id,selection.position,
    ${historical ? 'selection.user_name' : 'coalesce(person.name,selection.user_name)'} AS name,
    ${historical ? 'selection.username' : 'coalesce(person.username,selection.username)'} AS username
    FROM instrument_version_users selection ${historical ? '' : 'LEFT JOIN instrument_user_catalog person ON person.organization_id=selection.organization_id AND person.id=selection.user_id'}
    WHERE selection.organization_id=$1 AND selection.instrument_id=$2 AND selection.revision=$3 ORDER BY selection.position LIMIT 501`, args)).rows;
  const configurations = (await client.query(`SELECT ${serviceColumns} FROM instrument_version_services
    WHERE organization_id=$1 AND instrument_id=$2 AND revision=$3 ORDER BY position LIMIT 101`, args)).rows;
  const roles = configurations.length ? (await client.query(`SELECT service_id AS "serviceId",role_id AS id,position,role_name AS name FROM instrument_version_service_roles
    WHERE organization_id=$1 AND instrument_id=$2 AND revision=$3 ORDER BY service_id,position LIMIT 50001`, args)).rows : [];
  const incomplete = () => new HttpError(409, 'incomplete_instrument_history', 'Instrument history is incomplete. Reload before continuing.');
  if (allowedUsers.length !== item.userCount || allowedUsers.some((row, index) => row.position !== index)
    || configurations.length !== item.serviceCount || configurations.some((row, index) => row.position !== index) || roles.length > 50000) throw incomplete();
  const byId = new Map(configurations.map(row => [row.id, { ...row, reminderRoles: [] }]));
  for (const role of roles) {
    const configuration = byId.get(role.serviceId);
    if (!configuration || role.position !== configuration.reminderRoles.length) throw incomplete();
    configuration.reminderRoles.push({ id: role.id, name: role.name });
  }
  const serviceConfigurations = [...byId.values()].map(({ position: _position, roleCount, ...configuration }) => {
    if (configuration.reminderRoles.length !== roleCount) throw incomplete();
    return { ...configuration, reminderRoleIds: configuration.reminderRoles.map(role => role.id) };
  });
  const customFields = await loadMasterCustomFieldValues('instrument', client, identity, id, item.revision, item.customFieldCount);
  const customFieldTimeZone = customFields.find(field => ['date', 'date_time'].includes(field.fieldType))?.timeZone ?? null;
  return { ...item, allowedUsers: allowedUsers.map(({ position: _position, ...user }) => user), allowedUserIds: allowedUsers.map(user => user.id), serviceConfigurations,
    customFields, customFieldTimeZone };
}

export async function loadInstrumentCore(client, identity, instrumentId, { atRevision } = {}) {
  await requireInstrumentRead(client, identity); const id = uuid(instrumentId, 'Instrument').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const record = await readCore(client, identity, id, atRevision);
  if (!record || atRevision === undefined && record.retired) throw new HttpError(404, 'instrument_not_found', 'Instrument was not found.');
  return record;
}

async function finishCore(client) {
  await client.query('SET CONSTRAINTS instrument_relations_complete,instrument_head_history,instrument_custom_fields_complete IMMEDIATE');
  await client.query('SET CONSTRAINTS instrument_relations_complete,instrument_head_history,instrument_custom_fields_complete DEFERRED');
}

export async function saveInstrumentCore(client, identity, raw) {
  requirePermission(identity, 'instruments.manage'); const command = instrumentCommandInput(raw);
  try {
    await client.query('SELECT instruments_require_writer()');
    const existing = await readCore(client, identity, command.id);
    if (command.revision && !existing) throw new HttpError(404, 'instrument_not_found', 'Instrument was not found.');
    const input = instrumentCoreInput(raw, existing); const fingerprint = instrumentRequestFingerprint(raw, input);
    const prior = (await client.query('SELECT instruments_prior_request($1,$2,$3,$4,$5) AS revision',
      [input.id, input.revision, input.requestId, fingerprint, input.revision ? 'update' : 'create'])).rows[0].revision;
    if (prior !== null) return loadInstrumentCore(client, identity, input.id, { atRevision: prior });
    if (existing?.retired) throw new HttpError(404, 'instrument_not_found', 'Instrument was not found.');
    if ((existing?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_instrument', 'The Instrument changed. Reload before saving.');
    const definitions = await instrumentCustomFields(client, identity);
    const capture = await prepareMasterCustomFieldValues('instrument', client, identity, { definitions, entries: input.customFields,
      timeZone: input.customFieldTimeZone, previousFields: existing?.customFields ?? [] });
    const services = input.serviceConfigurations ?? [];
    const serviceKeys = ['id', 'serviceCode', 'templateId', 'workflowId', 'reminderBeforeDays', 'frequencyDays', 'lastPerformedOn', 'reminderFrequencyDays', 'nextReminderOn', 'active'];
    const roles = services.flatMap(service => service.reminderRoleIds.map(roleId => ({ serviceId: service.id, roleId })));
    const args = [input.id, input.revision, input.requestId, fingerprint, ...instrumentCoreFields.map(key => input[key]), input.allowedUserIds, input.serviceConfigurations !== null,
      ...serviceKeys.map(key => services.map(service => service[key])), roles.map(role => role.serviceId), roles.map(role => role.roleId), capture.count, capture.provided];
    const revision = (await client.query(`SELECT instruments_save(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args)).rows[0].revision;
    await appendMasterCustomFieldValues('instrument', client, identity, input.id, revision, capture);
    await finishCore(client);
    return loadInstrumentCore(client, identity, input.id, { atRevision: revision });
  } catch (error) { throw instrumentError(error); }
}

export async function retireInstrumentCore(client, identity, raw) {
  requirePermission(identity, 'instruments.manage'); fieldsOnly(raw, ['id', 'requestId', 'revision']);
  const input = instrumentCommandInput(raw); integer(input.revision, 'Revision', 1, 2_147_483_646);
  try {
    const revision = (await client.query('SELECT instruments_retire($1,$2,$3,$4) AS revision',
      [input.id, input.revision, input.requestId, instrumentRequestFingerprint(raw, input)])).rows[0].revision;
    await finishCore(client); return { id: input.id, revision };
  } catch (error) { throw instrumentError(error); }
}
