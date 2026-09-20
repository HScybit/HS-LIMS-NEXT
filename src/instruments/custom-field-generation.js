import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { generateMasterCustomFields } from '../masters/master-custom-field-generation.js';
import { instrumentServiceInput } from './input.js';

const strings = [
  ['name', 'name', 200], ['code', 'uniqueKey', 64], ['description', 'description', 5000], ['make', 'make', 200],
  ['modelName', 'model', 200], ['serialNumber', 'serialNumber', 200], ['dateOfInstallation', 'dateOfInstallation', 10],
  ['calibrationAgency', 'calibrationAgency', 250], ['currentLocation', 'currentLocation', 250], ['manufacturerSupplier', 'manufacturerSupplier', 250],
];

export function instrumentGenerationInput(input) {
  fieldsOnly(input, ['instrumentId', 'instrument', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.instrument, [...strings.map(([key]) => key), 'laboratoryId', 'purchaseFileId', 'allowedUserIds', 'costOfEquipment', 'calibrated', 'active', 'serviceConfigurations']);
  const doc = Object.fromEntries(strings.map(([key, source, maximum]) => [source, text(input.instrument[key], key, maximum, { optional: true })]));
  if (Object.values(doc).some(value => !value.isWellFormed() || value.includes('\0'))) throw new HttpError(400, 'invalid_input', 'Instrument text is invalid.');
  for (const [key, source] of [['laboratoryId', 'labId'], ['purchaseFileId', 'referencePurchaseFile']]) {
    const value = input.instrument[key]; doc[source] = value == null || value === '' ? '' : uuid(value, key).toLowerCase();
  }
  const users = input.instrument.allowedUserIds ?? [];
  if (!Array.isArray(users) || users.length > 500) throw new HttpError(400, 'invalid_input', 'Select at most 500 access users.');
  doc.allowAccessTo = Array.from(users, value => uuid(value, 'Access user').toLowerCase());
  if (new Set(doc.allowAccessTo).size !== users.length) throw new HttpError(400, 'invalid_input', 'Select distinct access users.');
  const cost = input.instrument.costOfEquipment ?? '';
  if (!(typeof cost === 'string' && cost.length <= 64 && cost.isWellFormed() && !cost.includes('\0') || typeof cost === 'number' && Number.isFinite(cost))) {
    throw new HttpError(400, 'invalid_input', 'Cost of equipment is invalid.');
  }
  doc.costOfEquipment = cost;
  doc.calibrated = bool(input.instrument.calibrated === undefined ? true : input.instrument.calibrated, 'Calibrated');
  doc.active = bool(input.instrument.active === undefined ? true : input.instrument.active, 'Active');
  const configurations = input.instrument.serviceConfigurations ?? [];
  if (!Array.isArray(configurations) || configurations.length > 100) throw new HttpError(400, 'invalid_input', 'Provide at most 100 service configurations.');
  const services = Array.from(configurations, instrumentServiceInput);
  if (new Set(services.map(service => service.id)).size !== services.length || new Set(services.map(service => service.serviceCode.toLowerCase())).size !== services.length) {
    throw new HttpError(400, 'invalid_input', 'Service configuration identities and types must be distinct.');
  }
  doc.serviceSchedules = Object.fromEntries(services.map(service => {
    return [service.serviceCode, { lastPerformedOn: service.lastPerformedOn ?? '', frequency: service.frequencyDays ?? '',
      remindBeforeDays: service.reminderBeforeDays, reminderFrequency: service.reminderFrequencyDays ?? '', remindTo: service.reminderRoleIds,
      template: service.templateId ?? '', workflow: service.workflowId ?? '' }];
  }));
  return { id: input.instrumentId == null ? null : uuid(input.instrumentId, 'Instrument').toLowerCase(), doc,
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(), customFields: customFieldValuesInput(input.customFields),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateInstrumentCustomFields(client, identity, input) {
  requirePermission(identity, 'instruments.manage');
  return generateMasterCustomFields('instrument', client, identity, instrumentGenerationInput(input));
}
