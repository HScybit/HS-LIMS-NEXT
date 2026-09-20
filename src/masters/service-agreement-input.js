import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { bool, dateOnly, decimal, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { serviceAgreementServices } from './service-agreement-fields.js';

export { serviceAgreementServices };
export const serviceAgreementFields = Object.freeze(['vendorId', 'startDate', 'endDate', 'noOfServices', 'cost', 'notes', 'inEffect', 'attachmentFileId']);

export function serviceAgreementCommandInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_input', 'Provide a Service Agreement command.');
  return { id: uuid(input.id, 'Service Agreement').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646) };
}

export function serviceAgreementInput(input, existing = null) {
  fieldsOnly(input, ['id', 'requestId', 'revision', ...serviceAgreementFields, 'instrumentIds', 'includedServices']);
  const command = serviceAgreementCommandInput(input);
  const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : existing?.[key] ?? fallback;
  const result = { ...command, vendorId: uuid(value('vendorId'), 'Vendor').toLowerCase(), startDate: dateOnly(value('startDate')), endDate: dateOnly(value('endDate')),
    noOfServices: integer(value('noOfServices', 0), 'No of Services', 0, 2_147_483_647), inEffect: bool(value('inEffect', false), 'In Effect') };
  if (result.endDate < result.startDate) throw new HttpError(400, 'invalid_agreement_dates', 'End Date cannot be before Start Date.');
  const cost = value('cost', '0'); result.cost = decimal(typeof cost === 'string' ? cost.trim() : cost, 'Cost');
  if (result.cost.startsWith('-') && /[1-9]/.test(result.cost.split(/[eE]/)[0])) throw new HttpError(400, 'invalid_agreement_cost', 'Cost cannot be negative.');
  const notes = value('notes', null);
  result.notes = notes === null ? null : text(notes, 'Notes', 10000, { optional: true }).trim();
  if (result.notes !== null && (!result.notes.isWellFormed() || result.notes.includes('\0'))) throw new HttpError(400, 'invalid_agreement_notes', 'Notes must contain valid text.');
  const fileId = value('attachmentFileId', null); result.attachmentFileId = fileId === null ? null : uuid(fileId, 'Attachment').toLowerCase();
  result.instrumentIds = null;
  if (Object.hasOwn(input, 'instrumentIds')) {
    if (!Array.isArray(input.instrumentIds) || !input.instrumentIds.length || input.instrumentIds.length > 500) throw new HttpError(400, 'invalid_agreement_instruments', 'Select between 1 and 500 Instruments.');
    result.instrumentIds = Array.from(input.instrumentIds, id => uuid(id, 'Instrument').toLowerCase());
    if (new Set(result.instrumentIds).size !== result.instrumentIds.length) throw new HttpError(400, 'invalid_agreement_instruments', 'Select distinct Instruments.');
  }
  if (!command.revision && result.instrumentIds === null) throw new HttpError(400, 'invalid_agreement_instruments', 'Select at least one Instrument.');
  result.includedServices = null;
  if (Object.hasOwn(input, 'includedServices')) {
    if (!Array.isArray(input.includedServices) || input.includedServices.length > 3) throw new HttpError(400, 'invalid_agreement_services', 'Select at most three supported services.');
    result.includedServices = Array.from(input.includedServices, code => {
      if (!serviceAgreementServices.some(service => service.value === code)) throw new HttpError(400, 'invalid_agreement_services', 'Select a supported service.');
      return code;
    });
    if (new Set(result.includedServices).size !== result.includedServices.length) throw new HttpError(400, 'invalid_agreement_services', 'Select distinct services.');
  }
  return result;
}

export function serviceAgreementRequestFingerprint(raw, input) {
  const intent = Object.fromEntries(Object.keys(raw).sort().map(key => {
    if (!Object.hasOwn(input, key)) throw new TypeError('Service Agreement receipts require validated input.');
    return [key, input[key]];
  }));
  return createHash('sha256').update(JSON.stringify(['service_agreement', intent])).digest('hex');
}
