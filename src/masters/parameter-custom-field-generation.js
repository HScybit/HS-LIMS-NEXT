import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { normalizeUncertaintyGrid, uncertaintySpreadsheet } from './parameter-grid.js';
import { generateMasterCustomFields } from './master-custom-field-generation.js';

export function parameterGenerationInput(input) {
  fieldsOnly(input, ['parameterId', 'parameter', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.parameter, ['name', 'description', 'key', 'schemeAbbreviation', 'order', 'laboratoryId', 'measurementUncertainty']);
  const parameter = input.parameter;
  const grid = normalizeUncertaintyGrid(parameter.measurementUncertainty);
  // Generation receives the actual form draft before the source's required-field validation.
  const order = parameter.order ?? '';
  if (!(typeof order === 'string' && order.length <= 64 || typeof order === 'number' && Number.isFinite(order))) {
    throw new HttpError(400, 'invalid_input', 'Parameter order is invalid.');
  }
  const doc = { name: text(parameter.name, 'Name', 200, { optional: true }), description: text(parameter.description, 'Description', 16000, { optional: true }),
    key: text(parameter.key, 'Key', 64, { optional: true }), scheme_abbr: text(parameter.schemeAbbreviation, 'Scheme Abbreviation', 64, { optional: true }), order,
    lab_id: parameter.laboratoryId == null || parameter.laboratoryId === '' ? '' : uuid(parameter.laboratoryId, 'Lab').toLowerCase(),
    measurement_uncertainty: grid ? uncertaintySpreadsheet(grid) : undefined };
  if (Object.values(doc).some((value) => typeof value === 'string' && (!value.isWellFormed() || value.includes('\0')))) {
    throw new HttpError(400, 'invalid_input', 'Parameter text is invalid.');
  }
  return { id: input.parameterId == null ? null : uuid(input.parameterId, 'Parameter').toLowerCase(), doc,
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(), customFields: customFieldValuesInput(input.customFields),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateParameterCustomFields(client, identity, input) {
  requirePermission(identity, 'masters.manage');
  return generateMasterCustomFields('parameter', client, identity, parameterGenerationInput(input));
}
