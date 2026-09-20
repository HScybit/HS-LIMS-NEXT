import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { vendorFormFields } from './vendor-fields.js';
import { generateMasterCustomFields } from './master-custom-field-generation.js';

export function vendorGenerationInput(input) {
  fieldsOnly(input, ['vendorId', 'vendor', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.vendor, vendorFormFields.map(field => field.key));
  const doc = Object.fromEntries(vendorFormFields.map(field => {
    const value = input.vendor[field.key] ?? field.defaultValue ?? '';
    if (field.type === 'number') {
      if (!(typeof value === 'string' && value.length <= 64 || typeof value === 'number' && Number.isFinite(value))) {
        throw new HttpError(400, 'invalid_input', `${field.label} is invalid.`);
      }
    } else if (field.type === 'boolean') {
      if (![true, false, 'true', 'false', ''].includes(value)) throw new HttpError(400, 'invalid_input', `${field.label} is invalid.`);
    } else if (field.type === 'select') {
      if (!['', ...field.options.map(option => option.value)].includes(value)) throw new HttpError(400, 'invalid_input', `${field.label} is invalid.`);
    } else text(value, field.label, field.maximum, { optional: true });
    if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) throw new HttpError(400, 'invalid_input', `${field.label} is invalid.`);
    return [field.source, value];
  }));
  return { id: input.vendorId == null ? null : uuid(input.vendorId, 'Vendor').toLowerCase(), doc,
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(), customFields: customFieldValuesInput(input.customFields),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateVendorCustomFields(client, identity, input) {
  requirePermission(identity, 'masters.manage');
  return generateMasterCustomFields('vendor', client, identity, vendorGenerationInput(input));
}
