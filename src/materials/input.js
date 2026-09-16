import { HttpError } from '../auth/errors.js';
import { decimal, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { canonicalDecimal } from '../datasheets/final-result.js';

export function materialText(value, label, maximum, optional = false) {
  const result = text(typeof value === 'string' ? value.trim() : value, label, maximum, { optional });
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

export function materialAmount(value, label, { optional = false, positive = false } = {}) {
  const result = decimal(typeof value === 'string' ? value.trim() : value, label, { optional });
  if (result === null) return null;
  const numeric = Number(result); const canonical = canonicalDecimal(result);
  const exponent = Number(/[eE]([+-]?\d+)$/.exec(result)?.[1] ?? 0);
  if (!canonical || Math.abs(exponent) > 1000 || numeric < 0 || (positive && numeric <= 0) || (numeric === 0 && canonical !== '0')) {
    throw new HttpError(400, 'invalid_number', `${label} must be a ${positive ? 'positive' : 'nonnegative'} finite quantity.`);
  }
  return result;
}

export function materialInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'code', 'description', 'categoryId', 'measurementUnitId', 'initialQuantity', 'minimumQuantity', 'maximumQuantity']);
  const result = { id: uuid(input.id, 'Material').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name: materialText(input.name, 'Name', 200),
    code: materialText(input.code, 'Unique key', 64), description: materialText(input.description, 'Description', 16000, true),
    categoryId: uuid(input.categoryId, 'Category').toLowerCase(), measurementUnitId: uuid(input.measurementUnitId, 'Unit').toLowerCase(),
    initialQuantity: materialAmount(input.initialQuantity, 'Initial quantity'), minimumQuantity: materialAmount(input.minimumQuantity, 'Min. quantity') };
  // The source form does not expose maximum quantity. Omitting it on edit retains the stored value.
  if (Object.hasOwn(input, 'maximumQuantity')) result.maximumQuantity = materialAmount(input.maximumQuantity, 'Max. quantity', { optional: true });
  return result;
}

export function materialTransactionInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'materialId', 'type', 'quantity', 'cost', 'supplier', 'batchSerialNumber', 'expiryDate']);
  if (!['in', 'out', 'out_damaged'].includes(input.type)) throw new HttpError(400, 'invalid_input', 'Select a valid transaction type.');
  return { id: uuid(input.id, 'Transaction').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    materialId: uuid(input.materialId, 'Material').toLowerCase(), type: input.type, quantity: materialAmount(input.quantity, 'Quantity', { positive: true }),
    cost: input.type === 'in' ? materialAmount(input.cost, 'Cost') : null,
    supplier: materialText(input.supplier, 'Make/Supplier', 250, true), batchSerialNumber: materialText(input.batchSerialNumber, 'Batch/Serial No', 150),
    expiryDate: input.type === 'in' ? materialText(input.expiryDate, 'Expiry date', 10, true) : '' };
}

export function materialFingerprint(value) {
  return JSON.stringify({ name: value.name, code: value.code, description: value.description, categoryId: value.categoryId,
    measurementUnitId: value.measurementUnitId, initialQuantity: canonicalDecimal(value.initialQuantity), minimumQuantity: canonicalDecimal(value.minimumQuantity),
    maximumQuantity: value.maximumQuantity == null ? null : canonicalDecimal(value.maximumQuantity) });
}
