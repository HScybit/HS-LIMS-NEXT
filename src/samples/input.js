import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, decimal, bool, integer, text, dateOnly } from '../templates/input.js';

const invalid = (message) => { throw new HttpError(400, 'invalid_sample', message); };
const optionalId = (value, label) => value == null ? null : uuid(value, label);
const optionalText = (value, label, maximum) => value == null ? null : text(value, label, maximum, { optional: true }).trim();
const optionalInteger = (value, label, minimum) => value == null ? null : integer(value, label, minimum, 2_147_483_647);

function choice(value, allowed, label, optional = false) {
  if (optional && value == null) return null;
  if (!allowed.includes(value)) invalid(`${label} is invalid.`);
  return value;
}

export function sampleTimestamp(value, label, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || value.length > 50 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) invalid(`${label} must include a valid date, time and timezone.`);
  dateOnly(value.slice(0, 10));
  if (!Number.isFinite(new Date(value).getTime())) invalid(`${label} is invalid.`);
  return value;
}

function quantity(value, label, { optional = false, minimum = 0, inclusive = false } = {}) {
  if (optional && value == null) return null;
  const parsed = decimal(value, label);
  if (inclusive ? Number(parsed) < minimum : Number(parsed) <= minimum) invalid(`${label} must be ${inclusive ? 'at least' : 'greater than'} ${minimum}.`);
  return parsed;
}

function currency(value) {
  const result = optionalText(value, 'Currency', 3)?.toUpperCase() ?? null;
  if (result !== null && !/^[A-Z]{3}$/.test(result)) invalid('Currency must be a three-letter code.');
  return result;
}

function amountPair(amount, code, label) {
  if ((amount == null) !== (code == null)) invalid(`${label} and currency must be supplied together.`);
}

function pendingCustomFields(value) {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
  // Never discard supplied scientific metadata while its typed adapter is pending.
  throw new HttpError(422, 'project_fields_unavailable', 'These project fields cannot be saved yet.');
}

function testInput(input, editing = false) {
  fieldsOnly(input, ['testParameterId', 'methodId', 'decisionRuleId', 'requestedQuantity', 'requestedSize', 'rate', 'currencyCode', 'estimatedDurationMinutes', 'isAccredited', 'isRetest', 'isSubcontracted', ...(editing ? ['id'] : [])]);
  const result = {
    ...(editing ? { id: optionalId(input.id, 'Selected test')?.toLowerCase() ?? null } : {}),
    testParameterId: uuid(input.testParameterId, 'Parameter'), methodId: uuid(input.methodId, 'Method'), decisionRuleId: optionalId(input.decisionRuleId, 'Decision rule'),
    requestedQuantity: integer(input.requestedQuantity ?? 1, 'Requested quantity', 1, 2_147_483_647), requestedSize: optionalText(input.requestedSize, 'Requested size', 150),
    rate: quantity(input.rate, 'Rate', { optional: true, inclusive: true }), currencyCode: currency(input.currencyCode),
    estimatedDurationMinutes: optionalInteger(input.estimatedDurationMinutes, 'Estimated duration', 0), isAccredited: bool(input.isAccredited ?? false, 'Accreditation'),
    isRetest: bool(input.isRetest ?? false, 'Retest'), isSubcontracted: bool(input.isSubcontracted ?? false, 'Subcontract'),
  };
  amountPair(result.rate, result.currencyCode, 'Rate');
  return result;
}

export function sampleProductInput(input, categoryId, editing = false) {
  fieldsOnly(input, ['productId', 'sampleCategoryId', 'quantity', 'customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'condition', 'measurementUnitId', 'imageFileId', 'tag', 'tagId', 'customFields', 'tests', ...(editing ? ['id'] : [])]);
  pendingCustomFields(input.customFields);
  if (!Array.isArray(input.tests) || !input.tests.length || input.tests.length > 1000) invalid('Select between 1 and 1,000 tests per product.');
  const tests = input.tests.map((test) => testInput(test, editing));
  if (editing) for (const test of tests) for (const key of ['testParameterId', 'methodId', 'decisionRuleId']) test[key] = test[key]?.toLowerCase() ?? null;
  const keys = tests.map((test) => `${test.testParameterId}:${test.methodId}:${test.isRetest}`);
  if (new Set(keys).size !== keys.length) invalid('The same parameter and method cannot be selected twice for one product.');
  return {
    ...(editing ? { id: optionalId(input.id, 'Sample line')?.toLowerCase() ?? null } : {}),
    productId: uuid(input.productId, 'Product'), sampleCategoryId: uuid(input.sampleCategoryId ?? categoryId, 'Product category'), quantity: quantity(input.quantity ?? 1, 'Product quantity'),
    customerReference: optionalText(input.customerReference, 'Product reference', 150), description: optionalText(input.description, 'Product description', 2000),
    sampleSize: optionalText(input.sampleSize, 'Sample size', 120), quality: optionalText(input.quality, 'Quality', 200),
    identificationMark: optionalText(input.identificationMark, 'Identification mark', 250), receivedCondition: optionalText(input.condition, 'Received condition', 250),
    imageFileId: optionalId(input.imageFileId, 'Sample image')?.toLowerCase() ?? null,
    measurementUnitId: optionalId(input.measurementUnitId, 'Unit'), tag: optionalText(input.tag, 'Tag', 250), tagId: optionalId(input.tagId, 'Tag'), tests,
  };
}

export function sampleRegistrationInput(input) {
  fieldsOnly(input, ['customerId', 'sampleCategoryId', 'customerAddress', 'customerQuotationId', 'customerReference', 'sampleType', 'receivedAt', 'dueAt', 'quantity', 'description', 'storageLocation',
    'iqcType', 'participantCount', 'ilcMode', 'participatingLabs', 'modeOfReceipt', 'totalAmount', 'currencyCode', 'receivedByName', 'collectionDetails', 'amendmentRemarks', 'complaintRemarks', 'customFields', 'products']);
  pendingCustomFields(input.customFields);
  const result = {
    customerId: optionalId(input.customerId, 'Customer'), sampleCategoryId: uuid(input.sampleCategoryId, 'Sample category'),
    customerAddress: optionalText(input.customerAddress, 'Customer address', 5000), customerQuotationId: optionalId(input.customerQuotationId, 'Quotation'),
    customerReference: optionalText(input.customerReference, 'Customer reference', 150),
    sampleType: choice(input.sampleType ?? 'customer', ['customer', 'internal', 'quality_control', 'proficiency', 'interlaboratory', 'amendment', 'complaint'], 'Sample type'),
    receivedAt: sampleTimestamp(input.receivedAt, 'Received date'), dueAt: sampleTimestamp(input.dueAt, 'Due date', true), quantity: quantity(input.quantity, 'Quantity', { optional: true }),
    description: optionalText(input.description, 'Description', 5000), storageLocation: optionalText(input.storageLocation, 'Storage location', 200),
    iqcType: choice(input.iqcType, ['repetition', 'retest', 'blind', 'int_lab'], 'IQC type', true), participantCount: optionalInteger(input.participantCount, 'Participant count', 1),
    ilcMode: choice(input.ilcMode, ['organizer', 'participant'], 'ILC mode', true), modeOfReceipt: optionalText(input.modeOfReceipt, 'Mode of receipt', 200),
    totalAmount: quantity(input.totalAmount, 'Amount', { optional: true, inclusive: true }), currencyCode: currency(input.currencyCode),
    receivedByName: optionalText(input.receivedByName, 'Received by', 200), collectionDetails: optionalText(input.collectionDetails, 'Collection details', 5000),
    amendmentRemarks: optionalText(input.amendmentRemarks, 'Amendment remarks', 5000), complaintRemarks: optionalText(input.complaintRemarks, 'Complaint remarks', 5000),
  };
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 100) invalid('Add between 1 and 100 products.');
  result.products = input.products.map((product) => sampleProductInput(product, result.sampleCategoryId));
  if (result.products.reduce((count, product) => count + product.tests.length, 0) > 5000) invalid('A sample cannot exceed 5,000 selected tests.');
  const labs = input.participatingLabs ?? [];
  if (!Array.isArray(labs) || labs.length > 100) invalid('Add at most 100 participating labs.');
  result.participatingLabs = labs.map((lab) => {
    fieldsOnly(lab, ['laboratoryId', 'laboratoryName']);
    return { laboratoryId: optionalId(lab.laboratoryId, 'Laboratory'), laboratoryName: text(lab.laboratoryName, 'Laboratory name', 250) };
  });
  if (result.dueAt && new Date(result.dueAt) < new Date(result.receivedAt)) invalid('Due date cannot be earlier than the received date.');
  if (result.customerQuotationId && !result.customerId) invalid('A customer must be selected before a quotation.');
  if (result.sampleType === 'customer' && !result.customerId) invalid('Customer is required.');
  if (result.customerId && !result.customerAddress) invalid('Customer address is required.');
  if (result.sampleType === 'quality_control' && !result.iqcType) invalid('IQC type is required.');
  if (result.sampleType !== 'quality_control' && (result.iqcType || result.participantCount)) invalid('IQC details require a quality-control sample.');
  if (result.iqcType === 'int_lab' && !result.participantCount) invalid('Participant count is required for an intralab sample.');
  if (result.sampleType === 'interlaboratory' && !result.ilcMode) invalid('ILC mode is required.');
  if (result.sampleType !== 'interlaboratory' && (result.ilcMode || result.participatingLabs.length)) invalid('Participating labs require an interlaboratory sample.');
  if (result.ilcMode === 'organizer' && !result.participatingLabs.length) invalid('Add at least one ILC lab.');
  if (result.sampleType === 'complaint' && !result.products.some((product) => product.tests.some((test) => test.isRetest))) invalid('Mark at least one complaint parameter for retest.');
  amountPair(result.totalAmount, result.currencyCode, 'Amount');
  return result;
}

export function quickCustomerInput(input) {
  const fields = [['name', 'Name', 250], ['legalName', 'Legal name', 250], ['contactPersonName', 'Contact person', 200],
    ['contactPersonEmail', 'Contact email', 320], ['contactPersonPhone', 'Contact phone', 50], ['billToAddress', 'Bill to address', 4000], ['shipToAddress', 'Ship to address', 4000]];
  fieldsOnly(input, fields.map(([key]) => key));
  const result = Object.fromEntries(fields.map(([key, label, maximum]) => [key, text(input[key], label, maximum)]));
  if (!/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(result.contactPersonEmail)) throw new HttpError(400, 'invalid_email', 'Enter a valid contact email.');
  return result;
}
