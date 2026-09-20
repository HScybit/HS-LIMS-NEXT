import { HttpError } from '../auth/errors.js';
import { decimal, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { sampleTimestamp } from './input.js';

const textFields = {
  customerAddress: ['Customer address', 5000], customerReference: ['Customer reference', 150],
  description: ['Description', 5000], storageLocation: ['Storage location', 200],
  modeOfReceipt: ['Mode of receipt', 200], receivedByName: ['Received by', 200],
  collectionDetails: ['Collection details', 5000], amendmentRemarks: ['Amendment remarks', 5000],
  complaintRemarks: ['Complaint remarks', 5000], complaintRca: ['Root cause', 5000], complaintCapa: ['Corrective/preventive action', 5000],
};
const ordinaryFields = ['customerId', 'customerQuotationId', 'customerAddress', 'customerReference', 'receivedAt', 'dueAt',
  'quantity', 'description', 'storageLocation', 'modeOfReceipt', 'totalAmount', 'currencyCode', 'receivedByName', 'collectionDetails'];
export const sampleHeaderFields = [...ordinaryFields, 'amendmentRemarks', 'complaintRemarks', 'complaintRca', 'complaintCapa'];
const invalid = message => { throw new HttpError(400, 'invalid_sample', message); };

export function sampleHeaderRevision(input) {
  fieldsOnly(input, ['revision', ...sampleHeaderFields]);
  return integer(input.revision, 'Sample revision', 1, 2_147_483_647);
}

export function sampleEditableHeaderFields(sampleType) {
  if (sampleType === 'amendment') return ['customerId', 'customerQuotationId', 'customerAddress', 'modeOfReceipt', 'collectionDetails', 'amendmentRemarks'];
  if (sampleType === 'complaint') return ['customerAddress', 'complaintRemarks', 'complaintRca', 'complaintCapa'];
  if (sampleType === 'quality_control') return ['customerAddress'];
  return ordinaryFields;
}

export function sampleHeaderUpdateInput(input, sampleType) {
  const revision = sampleHeaderRevision(input);
  const changes = {};
  // Match the source's special-edit whitelist before interpreting locked values.
  // Unknown keys still fail the transport contract, including immutable identity.
  for (const key of sampleEditableHeaderFields(sampleType)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (value === undefined) invalid('Omit unchanged sample fields instead of sending undefined.');
    if (textFields[key]) {
      const [label, maximum] = textFields[key];
      if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) invalid(`${label} contains invalid text.`);
      changes[key] = value === null ? null : text(value, label, maximum, { optional: true }).trim();
    } else if (key === 'customerId' || key === 'customerQuotationId') {
      changes[key] = value === null ? null : uuid(value, key === 'customerId' ? 'Customer' : 'Quotation').toLowerCase();
    } else if (key === 'receivedAt' || key === 'dueAt') {
      changes[key] = sampleTimestamp(value, key === 'receivedAt' ? 'Received date' : 'Due date', key === 'dueAt');
    } else if (key === 'currencyCode') {
      changes[key] = value === null ? null : text(value, 'Currency', 3, { optional: true }).trim().toUpperCase();
      if (changes[key] !== null && !/^[A-Z]{3}$/.test(changes[key])) invalid('Currency must be a three-letter code.');
    } else {
      const label = key === 'quantity' ? 'Quantity' : 'Amount';
      const parsed = value === null ? null : decimal(value, label);
      const negative = parsed?.startsWith('-') && /[1-9]/.test(parsed.split(/[eE]/)[0]);
      if (parsed !== null && (key === 'quantity' ? Number(parsed) <= 0 : negative)) {
        invalid(`${label} must be ${key === 'quantity' ? 'greater than' : 'at least'} zero.`);
      }
      changes[key] = parsed;
    }
  }
  return { revision, changes };
}

export function validateSampleHeaderChanges(existing, changes) {
  const current = { ...existing, ...changes };
  if (current.sampleType === 'customer' && !current.customerId) invalid('Customer is required.');
  if (current.customerQuotationId && !current.customerId) invalid('A customer must be selected before a quotation.');
  if (current.customerId && !current.customerAddress?.trim()) invalid('Customer address is required.');
  if ((current.totalAmount == null) !== (current.currencyCode == null)) invalid('Amount and currency must be supplied together.');
  if (current.dueAt && new Date(current.dueAt) < new Date(current.receivedAt)) invalid('Due date cannot be earlier than the received date.');
}
