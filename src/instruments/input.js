import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { bool, dateOnly, decimal, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';

export const instrumentCoreFields = Object.freeze(['code', 'name', 'description', 'laboratoryId', 'make', 'modelName', 'serialNumber', 'dateOfInstallation',
  'calibrationAgency', 'calibrated', 'costOfEquipment', 'purchaseFileId', 'currentLocation', 'manufacturerSupplier', 'active']);

function instrumentText(value, label, maximum, optional = false) {
  if (optional && value == null) return null;
  const result = text(typeof value === 'string' ? value.trim() : value, label, maximum, { optional });
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_instrument_text', `${label} contains invalid text.`);
  return optional && !result ? null : result;
}

function identifiers(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 500) throw new HttpError(400, 'invalid_instrument_references', `Select ${minimum ? 'at least one and ' : ''}at most 500 ${label}.`);
  const result = Array.from(value, id => uuid(id, label).toLowerCase());
  if (new Set(result).size !== result.length) throw new HttpError(400, 'invalid_instrument_references', `Select distinct ${label}.`);
  return result;
}

const optionalId = (value, label) => value == null || value === '' ? null : uuid(value, label).toLowerCase();
const optionalDate = value => value == null || value === '' ? null : dateOnly(value);
const optionalInteger = (value, label, maximum) => value == null ? null : integer(value, label, 1, maximum);

export function instrumentServiceInput(input) {
  fieldsOnly(input, ['id', 'serviceCode', 'templateId', 'workflowId', 'reminderRoleIds', 'reminderBeforeDays', 'frequencyDays', 'lastPerformedOn', 'reminderFrequencyDays', 'nextReminderOn', 'active']);
  const serviceCode = instrumentText(input.serviceCode, 'Service key', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(serviceCode)) throw new HttpError(400, 'invalid_instrument_service', 'Select a supported service key.');
  const templateId = optionalId(input.templateId, 'Template'); const workflowId = optionalId(input.workflowId, 'Workflow');
  const reminderRoleIds = identifiers(input.reminderRoleIds === undefined ? [] : input.reminderRoleIds, 'reminder roles');
  if (Boolean(templateId) !== Boolean(workflowId) || templateId && !reminderRoleIds.length) {
    throw new HttpError(400, 'invalid_instrument_service', 'Configure Template and Workflow together with at least one reminder role.');
  }
  return { id: uuid(input.id, 'Service configuration').toLowerCase(), serviceCode, templateId, workflowId, reminderRoleIds,
    reminderBeforeDays: integer(input.reminderBeforeDays === undefined ? 1 : input.reminderBeforeDays, 'Remind before days', 0, 3650),
    frequencyDays: optionalInteger(input.frequencyDays, 'Frequency', 36500), lastPerformedOn: optionalDate(input.lastPerformedOn),
    reminderFrequencyDays: optionalInteger(input.reminderFrequencyDays, 'Reminder frequency', 3650), nextReminderOn: optionalDate(input.nextReminderOn),
    active: bool(input.active === undefined ? true : input.active, 'Service active') };
}

export function instrumentCommandInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_input', 'Provide an Instrument command.');
  return { id: uuid(input.id, 'Instrument').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646) };
}

export function instrumentCoreInput(input, existing = null) {
  fieldsOnly(input, ['id', 'requestId', 'revision', ...instrumentCoreFields, 'allowedUserIds', 'serviceConfigurations', 'customFields', 'customFieldTimeZone']);
  const command = instrumentCommandInput(input);
  const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : existing?.[key] ?? fallback;
  const result = { ...command, name: instrumentText(value('name'), 'Name', 200), code: instrumentText(value('code'), 'Unique Key', 64),
    laboratoryId: uuid(value('laboratoryId'), 'Lab').toLowerCase(), dateOfInstallation: dateOnly(value('dateOfInstallation')),
    calibrated: bool(value('calibrated', true), 'Calibrated'), active: bool(value('active', true), 'Active'), purchaseFileId: optionalId(value('purchaseFileId'), 'Purchase file') };
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result.code)) throw new HttpError(400, 'invalid_instrument_code', 'Unique Key must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens.');
  for (const [key, label, maximum] of [['description', 'Description', 5000], ['make', 'Make', 200], ['modelName', 'Model', 200], ['serialNumber', 'Serial Number', 200],
    ['calibrationAgency', 'Calibration agency', 250], ['currentLocation', 'Current location', 250], ['manufacturerSupplier', 'Manufacturer/supplier', 250]]) {
    result[key] = instrumentText(value(key), label, maximum, true);
  }
  const cost = value('costOfEquipment');
  result.costOfEquipment = decimal(typeof cost === 'string' ? cost.trim() : cost, 'Cost of equipment', { optional: true });
  if (result.costOfEquipment?.startsWith('-') && /[1-9]/.test(result.costOfEquipment.split(/[eE]/)[0])) throw new HttpError(400, 'invalid_instrument_cost', 'Cost of equipment cannot be negative.');
  result.allowedUserIds = Object.hasOwn(input, 'allowedUserIds') ? identifiers(input.allowedUserIds, 'access users', 1) : null;
  if (!command.revision && result.allowedUserIds === null) throw new HttpError(400, 'invalid_instrument_references', 'Select at least one access user.');
  result.serviceConfigurations = null;
  if (Object.hasOwn(input, 'serviceConfigurations')) {
    if (!Array.isArray(input.serviceConfigurations) || input.serviceConfigurations.length > 100) throw new HttpError(400, 'invalid_instrument_services', 'Provide at most 100 service configurations.');
    result.serviceConfigurations = Array.from(input.serviceConfigurations, instrumentServiceInput);
    if (new Set(result.serviceConfigurations.map(service => service.id)).size !== result.serviceConfigurations.length
      || new Set(result.serviceConfigurations.map(service => service.serviceCode.toLowerCase())).size !== result.serviceConfigurations.length) {
      throw new HttpError(400, 'invalid_instrument_services', 'Service configuration identities and types must be distinct.');
    }
  }
  result.customFields = input.customFields === undefined ? undefined : customFieldValuesInput(input.customFields);
  result.customFieldTimeZone = input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone);
  return result;
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}

export function instrumentRequestFingerprint(raw, input) {
  const intent = Object.fromEntries(Object.keys(raw).sort().map(key => {
    if (!Object.hasOwn(input, key)) throw new TypeError('Instrument receipts require validated input.');
    return [key, input[key]];
  }));
  return createHash('sha256').update(JSON.stringify(['instrument', ordered(intent)])).digest('hex');
}
