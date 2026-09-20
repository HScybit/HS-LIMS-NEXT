import { dateOnly } from '../templates/input.js';
import { sampleHeaderFields, sampleEditableHeaderFields, sampleHeaderUpdateInput } from './update-input.js';
import { sampleProductsUpdateInput } from './lines-input.js';
import { complaintRetestInput } from './complaint-input.js';
import { calculateSampleReportingDate } from './reporting-date.js';

const controlValue = value => value == null ? '' : String(value);
const sameValue = (left, right) => controlValue(left) === controlValue(right);
const day = value => value ? String(value).slice(0, 10) : '';
const ordinary = type => ['customer', 'internal', 'proficiency', 'interlaboratory'].includes(type);

export function sampleEditKind(sample) {
  if (sample.sampleType === 'quality_control') return sample.iqcType === 'int_lab' ? 'intralab' : 'iqc';
  if (sample.sampleType === 'interlaboratory') return sample.ilcMode === 'participant' ? 'ilc_participation' : 'ilc';
  return ({ proficiency: 'pt', amendment: 'amendment', complaint: 'complaint' })[sample.sampleType] ?? 'base';
}

export function sampleEditForm(sample) {
  return {
    ...Object.fromEntries(sampleHeaderFields.map(key => [key, sample[key] ?? ''])),
    kind: sampleEditKind(sample), receivedAt: day(sample.receivedAt), dueAt: day(sample.dueAt), currencyCode: sample.currencyCode ?? 'INR',
    iqcType: sample.iqcType ?? '', participantCount: sample.participantCount ?? '',
    participatingLabs: (sample.participatingLabs ?? []).map(lab => ({ ...lab, key: lab.id })),
    products: sample.products.map(product => ({ ...product, key: product.id,
      ...Object.fromEntries(['tagId', 'customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'measurementUnitId'].map(key => [key, product[key] ?? ''])),
      condition: product.receivedCondition ?? '',
      tests: product.tests.map(test => ({ ...test, key: test.id, requestedSize: test.requestedSize ?? '', rate: test.rate ?? '',
        estimatedDurationDays: test.estimatedDurationMinutes == null ? '' : test.estimatedDurationMinutes / 480 })),
    })),
  };
}

export function sampleFormEditPolicy(sample, options) {
  const headers = new Set(sampleEditableHeaderFields(sample.sampleType));
  if (!options.allowReceivingDateEdit) headers.delete('receivedAt');
  return { headers, products: ordinary(sample.sampleType), retests: sample.sampleType === 'complaint' };
}

// A saved inactive choice belongs to its original row, never a new row or a
// different Product with the same label or position.
export function retainedSampleOption(options, value, savedValue, savedLabel) {
  if (!value || value !== savedValue || options.some(option => option.value === value)) return options;
  return [...options, { value, label: savedLabel ?? String(value) }];
}

const activeTests = (products, type) => products.flatMap(product => product.tests.filter(test => type !== 'complaint' || test.isRetest));
const signature = tests => tests.map(test => test.id || test.key).sort().join('|');

export function sampleEditReportingDate(form, sample, options) {
  const tests = activeTests(form.products, sample.sampleType);
  const original = signature(activeTests(sample.products, sample.sampleType));
  const rowsChanged = Boolean(original && original !== signature(tests));
  const days = tests.map(test => Number(test.estimatedDurationDays)).filter(value => Number.isFinite(value) && value > 0);
  const lines = form.products.filter(product => sample.sampleType !== 'complaint' || product.tests.some(test => test.isRetest));
  const categoryDays = lines.map(product => Number(options.sampleCategories.find(category => category.id === product.sampleCategoryId)?.estimatedTimeInDays))
    .filter(value => Number.isFinite(value) && value > 0);
  const estimate = calculateSampleReportingDate(form.receivedAt, Math.max(0, ...(days.length ? days : categoryDays)));
  return { dueAt: rowsChanged && estimate ? estimate : form.dueAt || estimate, recalculated: Boolean(rowsChanged && estimate) };
}

function editedValue(row, saved, key, fallback = null) {
  return saved && sameValue(row[key], saved[key]) ? saved[key] : row[key] === '' ? fallback : row[key] ?? fallback;
}

function productPayload(product, saved, currencyCode) {
  const savedTests = new Map((saved?.tests ?? []).map(test => [test.id, test]));
  return {
    ...(product.id ? { id: product.id } : {}), productId: product.productId, sampleCategoryId: product.sampleCategoryId,
    imageFileId: product.imageFileId ?? null,
    quantity: editedValue(product, saved, 'quantity'), tagId: product.tagId || null,
    tag: saved && product.tagId === (saved.tagId ?? '') ? saved.tag : null,
    ...Object.fromEntries(['customerReference', 'description', 'sampleSize', 'quality', 'identificationMark', 'measurementUnitId'].map(key => [key, editedValue(product, saved, key)])),
    condition: saved && sameValue(product.condition, saved.receivedCondition) ? saved.receivedCondition : product.condition,
    tests: product.tests.map(test => {
      const previous = savedTests.get(test.id);
      const rate = editedValue(test, previous, 'rate');
      const daysUnchanged = previous && sameValue(test.estimatedDurationDays, previous.estimatedDurationMinutes == null ? '' : previous.estimatedDurationMinutes / 480);
      return {
        ...(test.id ? { id: test.id } : {}), testParameterId: test.testParameterId, methodId: test.methodId, decisionRuleId: test.decisionRuleId || null,
        requestedQuantity: Number(test.requestedQuantity), requestedSize: editedValue(test, previous, 'requestedSize'), rate,
        currencyCode: rate == null ? null : previous?.currencyCode ?? currencyCode,
        estimatedDurationMinutes: daysUnchanged ? previous.estimatedDurationMinutes : test.estimatedDurationDays === '' ? null : Math.round(Number(test.estimatedDurationDays) * 480),
        isAccredited: test.isAccredited, isRetest: test.isRetest, isSubcontracted: test.isSubcontracted,
      };
    }),
  };
}

export function sampleEditPayload(form, sample, options) {
  const initial = sampleEditForm(sample); const policy = sampleFormEditPolicy(sample, options);
  const payload = { revision: sample.revision };
  for (const key of policy.headers) {
    if (sameValue(form[key], initial[key])) continue;
    if (key === 'receivedAt' || key === 'dueAt') {
      if (key === 'dueAt' && form[key] === '') payload[key] = null;
      else { dateOnly(form[key]); payload[key] = `${form[key]}T00:00:00Z`; }
    } else payload[key] = ['customerId', 'customerQuotationId', 'totalAmount', 'currencyCode', 'quantity'].includes(key) && form[key] === '' ? null : form[key];
  }
  if (Object.hasOwn(payload, 'totalAmount')) payload.currencyCode = payload.totalAmount == null ? null : form.currencyCode;
  const reporting = sampleEditReportingDate(form, sample, options);
  if (policy.headers.has('dueAt') && reporting.recalculated && reporting.dueAt !== initial.dueAt) payload.dueAt = `${reporting.dueAt}T00:00:00Z`;
  sampleHeaderUpdateInput(payload, sample.sampleType);
  if (policy.products) {
    const savedLines = new Map(sample.products.map(product => [product.id, product]));
    const products = form.products.map(product => productPayload(product, savedLines.get(product.id), form.currencyCode));
    const original = initial.products.map(product => productPayload(product, savedLines.get(product.id), initial.currencyCode));
    if (JSON.stringify(products) !== JSON.stringify(original)) {
      const categoryId = products[0]?.sampleCategoryId;
      sampleProductsUpdateInput(products, categoryId);
      payload.products = products;
      if (categoryId !== sample.sampleCategoryId) payload.sampleCategoryId = categoryId;
    }
  } else if (policy.retests) {
    const ids = complaintRetestInput(activeTests(form.products, 'complaint').map(test => test.id));
    if (signature(sample.products.flatMap(product => product.tests)) !== [...ids].sort().join('|')) payload.complaintRetestIds = ids;
  }
  return payload;
}
