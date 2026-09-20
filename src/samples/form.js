import { dateOnly } from '../templates/input.js';
import { sampleRegistrationInput } from './input.js';

export const sampleKinds = [
  { value: 'base', label: 'Base', sampleType: 'customer' },
  { value: 'iqc', label: 'IQC', sampleType: 'quality_control' },
  { value: 'ilc', label: 'ILC Sample', title: 'ILC', sampleType: 'interlaboratory', ilcMode: 'organizer' },
  { value: 'pt', label: 'PT Sample', title: 'PT', sampleType: 'proficiency' },
  { value: 'ilc_participation', label: 'ILC participation Sample', title: 'ILC Participation', sampleType: 'interlaboratory', ilcMode: 'participant' },
  { value: 'intralab', label: 'Intralab', sampleType: 'quality_control', iqcType: 'int_lab' },
  { value: 'amendment', label: 'Amendment', sampleType: 'amendment' },
  { value: 'complaint', label: 'Complaint', sampleType: 'complaint' },
];

export function localDate(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function newTest() {
  return { key: crypto.randomUUID(), testParameterId: '', methodId: '', decisionRuleId: null, requestedQuantity: 1, requestedSize: '', rate: '',
    estimatedDurationDays: '', isAccredited: false, isRetest: false, isSubcontracted: false };
}

export function newProduct(sampleCategoryId = '') {
  return { key: crypto.randomUUID(), sampleCategoryId, productId: '', tagId: '', quantity: '1', customerReference: '', description: '',
    sampleSize: '', quality: '', identificationMark: '', condition: '', measurementUnitId: '', imageFileId: null, image: null, tests: [newTest()] };
}

export function newRegistration(kind = 'base', receivedByName = '', now = new Date()) {
  const aliases = { is_ilc_sample: 'ilc', is_pt_sample: 'pt', is_ilc_participation_sample: 'ilc_participation', is_intralab: 'intralab' };
  const selected = aliases[kind] ?? kind;
  return { kind: sampleKinds.some((item) => item.value === selected) ? selected : 'base', customerId: '', customerAddress: '', customerQuotationId: '', customerReference: '',
    receivedAt: localDate(now), dueAt: '', iqcType: '', participantCount: '', participatingLabs: [], modeOfReceipt: '', totalAmount: '', currencyCode: 'INR',
    receivedByName, storageLocation: '', collectionDetails: '', amendmentRemarks: '', complaintRemarks: '', description: '', products: [newProduct()] };
}

export function changeSampleKind(form, value) {
  const kind = sampleKinds.find((item) => item.value === value) ?? sampleKinds[0];
  return { ...form, kind: kind.value, iqcType: kind.iqcType ?? '',
    participantCount: kind.iqcType === 'int_lab' ? form.participantCount : '',
    participatingLabs: kind.ilcMode === 'organizer' ? form.participatingLabs : [],
    amendmentRemarks: kind.sampleType === 'amendment' ? form.amendmentRemarks : '',
    complaintRemarks: kind.sampleType === 'complaint' ? form.complaintRemarks : '' };
}

export function productParameters(options, product) {
  const allowed = new Set(options.decisionRules.filter((rule) => rule.productId === product.productId
    && (!rule.sampleCategoryIds.length || rule.sampleCategoryIds.includes(product.sampleCategoryId))).map((rule) => rule.testParameterId));
  return options.testParameters.filter((parameter) => allowed.has(parameter.id));
}

function applicableRules(options, product, parameterId) {
  return options.decisionRules.filter((rule) => rule.productId === product.productId && rule.testParameterId === parameterId
    && (!rule.sampleCategoryIds.length || rule.sampleCategoryIds.includes(product.sampleCategoryId)))
    .sort((left, right) => Number(Boolean(right.methodId)) - Number(Boolean(left.methodId))
      || Number(right.sampleCategoryIds.length > 0) - Number(left.sampleCategoryIds.length > 0) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function availableMethods(options, product, parameterId) {
  const methods = options.testParameters.find((row) => row.id === parameterId)?.methods ?? [];
  const rules = applicableRules(options, product, parameterId);
  if (rules.some((rule) => !rule.methodId)) return methods;
  const ids = new Set(rules.map((rule) => rule.methodId));
  return methods.filter((method) => ids.has(method.id));
}

export function testSelection(options, product, parameterId, methodId) {
  const methods = availableMethods(options, product, parameterId);
  // Preserve the routed PERN form's explicit default method and most specific
  // matching criterion; both are constrained to the selected product/category.
  const selectedMethod = methodId ?? methods.find((method) => method.isDefault)?.id ?? methods[0]?.id ?? '';
  const rule = applicableRules(options, product, parameterId).find((row) => !row.methodId || row.methodId === selectedMethod);
  return { testParameterId: parameterId, methodId: selectedMethod, decisionRuleId: rule?.id ?? null, isAccredited: rule?.isNabl ?? false,
    ...(rule ? { requestedSize: rule.minimumSize ?? '', rate: rule.estimatedCharges ?? '', estimatedDurationDays: rule.estimatedTimeInDays ?? '' } : {}) };
}

const activeTests = (product, kind) => product.tests.filter((test) => kind !== 'complaint' || test.isRetest);
export function estimatedAmount(products, kind) {
  return products.reduce((total, product) => total + activeTests(product, kind).reduce((sum, test) => sum + Number(test.requestedQuantity) * Number(test.rate || 0), 0), 0);
}

export function estimatedReportingDate(form, options) {
  if (!form.receivedAt) return '';
  try { dateOnly(form.receivedAt); } catch { return ''; }
  const products = form.products.filter((product) => form.kind !== 'complaint' || activeTests(product, form.kind).length);
  const days = products.flatMap((product) => activeTests(product, form.kind)).filter((test) => test.testParameterId)
    .map((test) => Number(test.estimatedDurationDays)).filter((value) => Number.isFinite(value) && value > 0);
  const categoryDays = products.map((product) => options.sampleCategories.find((category) => category.id === product.sampleCategoryId)?.estimatedTimeInDays ?? 0);
  const maximum = Math.max(0, ...(days.length ? days : categoryDays));
  if (!maximum) return '';
  const date = new Date(`${form.receivedAt}T00:00:00`);
  date.setDate(date.getDate() + maximum);
  return Number.isFinite(date.getTime()) ? localDate(date) : '';
}

export function registrationPayload(form, options) {
  const kind = sampleKinds.find((item) => item.value === form.kind) ?? sampleKinds[0];
  const products = form.products.map((product) => ({ ...product, tests: activeTests(product, form.kind) }))
    .filter((product) => form.kind !== 'complaint' || product.tests.length);
  const dueAt = form.dueAt || estimatedReportingDate(form, options);
  dateOnly(form.receivedAt); dateOnly(dueAt);
  const iqcType = kind.sampleType === 'quality_control' ? kind.iqcType || form.iqcType || null : null;
  const payload = {
    sampleType: kind.sampleType, sampleCategoryId: products[0]?.sampleCategoryId,
    customerId: form.customerId || null, customerAddress: form.customerAddress || null, customerQuotationId: form.customerQuotationId || null, customerReference: form.customerReference || null,
    receivedAt: new Date(`${form.receivedAt}T00:00:00Z`).toISOString(), dueAt: new Date(`${dueAt}T00:00:00Z`).toISOString(),
    quantity: String(products.reduce((total, product) => total + Number(product.quantity), 0)),
    iqcType, participantCount: iqcType === 'int_lab' ? Number(form.participantCount) : null, ilcMode: kind.ilcMode ?? null,
    participatingLabs: kind.ilcMode === 'organizer' ? form.participatingLabs.filter((lab) => lab.laboratoryName.trim()).map((lab) => ({ laboratoryName: lab.laboratoryName.trim() })) : [],
    modeOfReceipt: form.modeOfReceipt, totalAmount: form.totalAmount === '' ? String(estimatedAmount(products, form.kind)) : form.totalAmount, currencyCode: form.currencyCode,
    receivedByName: form.receivedByName, storageLocation: form.storageLocation, collectionDetails: form.collectionDetails,
    amendmentRemarks: form.kind === 'amendment' ? form.amendmentRemarks : null, complaintRemarks: form.kind === 'complaint' ? form.complaintRemarks : null, description: form.description,
    products: products.map((product) => ({ productId: product.productId, sampleCategoryId: product.sampleCategoryId, tagId: product.tagId || null, quantity: product.quantity,
      customerReference: product.customerReference, description: product.description, sampleSize: product.sampleSize, quality: product.quality, identificationMark: product.identificationMark,
      condition: product.condition, measurementUnitId: product.measurementUnitId || null, imageFileId: product.imageFileId ?? null,
      tests: product.tests.map((test) => ({ testParameterId: test.testParameterId, methodId: test.methodId, decisionRuleId: test.decisionRuleId || null,
        requestedQuantity: Number(test.requestedQuantity), requestedSize: test.requestedSize, rate: test.rate === '' ? null : test.rate, currencyCode: test.rate === '' ? null : form.currencyCode,
        estimatedDurationMinutes: test.estimatedDurationDays === '' ? null : Math.round(Number(test.estimatedDurationDays) * 480),
        isAccredited: test.isAccredited, isRetest: test.isRetest, isSubcontracted: test.isSubcontracted })) })),
  };
  sampleRegistrationInput(payload);
  return payload;
}
