import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newProduct, newTest } from '../../src/samples/form.js';
import { sampleEditForm, sampleEditKind, sampleEditPayload, sampleEditReportingDate, sampleFormEditPolicy, retainedSampleOption } from '../../src/samples/edit-form.js';

function fixture() {
  const sample = { id: randomUUID(), revision: 7, sampleType: 'internal', sampleCategoryId: randomUUID(),
    customerId: null, customerAddress: '', customerQuotationId: null, customerReference: null, receivedAt: '2024-02-28T10:30:00.123456Z',
    dueAt: '2024-03-20T18:00:00.654321Z', quantity: '1.000000000000000001', description: null, storageLocation: '', modeOfReceipt: null,
    totalAmount: null, currencyCode: null, receivedByName: null, collectionDetails: '', amendmentRemarks: null, complaintRemarks: null, participatingLabs: [] };
  sample.products = [{ ...newProduct(sample.sampleCategoryId), id: randomUUID(), productId: randomUUID(), tagId: null, tag: null,
    quantity: '1.000000000000000001', description: null, quality: '', receivedCondition: ' good ', measurementUnitId: null, customerReference: null,
    tests: [{ ...newTest(), id: randomUUID(), testParameterId: randomUUID(), methodId: randomUUID(), decisionRuleId: randomUUID(),
      requestedQuantity: 2, requestedSize: null, rate: '0.000000000000000001', currencyCode: 'USD', estimatedDurationMinutes: 1, status: 'planned' }] }];
  return { sample, options: { allowReceivingDateEdit: true, sampleCategories: [{ id: sample.sampleCategoryId, estimatedTimeInDays: '3' }] } };
}

test('edit hydration and an unchanged save preserve precise, null, blank and zero values without mutating the sample', () => {
  const { sample, options } = fixture(); const before = structuredClone(sample); const form = sampleEditForm(sample);
  assert.equal(form.products[0].key, sample.products[0].id); assert.equal(form.products[0].tests[0].key, sample.products[0].tests[0].id);
  assert.equal(form.receivedByName, ''); assert.equal(form.receivedAt, '2024-02-28'); assert.equal(form.dueAt, '2024-03-20');
  assert.deepEqual(sampleEditPayload(form, sample, options), { revision: 7 }); assert.deepEqual(sample, before);
  form.customerAddress = 'Updated address';
  assert.deepEqual(sampleEditPayload(form, sample, options), { revision: 7, customerAddress: 'Updated address' });
});

test('a line edit retains exact numeric text, one-minute durations, row currency, hidden fields and stable IDs', () => {
  const { sample, options } = fixture(); const form = sampleEditForm(sample); form.products[0].description = 'Edited';
  const payload = sampleEditPayload(form, sample, options); const product = payload.products[0]; const selected = product.tests[0];
  assert.equal(product.id, sample.products[0].id); assert.equal(product.quantity, sample.products[0].quantity);
  assert.equal(product.condition, ' good '); assert.equal(product.customerReference, null);
  assert.equal(selected.id, sample.products[0].tests[0].id); assert.equal(selected.rate, '0.000000000000000001');
  assert.equal(selected.currencyCode, 'USD'); assert.equal(selected.estimatedDurationMinutes, 1); assert.equal(selected.requestedSize, null);
  assert.equal(selected.decisionRuleId, sample.products[0].tests[0].decisionRuleId);
  assert(!Object.hasOwn(payload, 'dueAt')); assert(!Object.hasOwn(payload, 'receivedAt'));
});

test('explicit amount and date changes validate and preserve nullable currency pairs', () => {
  const { sample, options } = fixture(); const form = sampleEditForm(sample); form.totalAmount = '0'; form.dueAt = '';
  assert.deepEqual(sampleEditPayload(form, sample, options), { revision: 7, dueAt: null, totalAmount: '0', currencyCode: 'INR' });
  form.receivedAt = '2024-02-30'; assert.throws(() => sampleEditPayload(form, sample, options));
  form.receivedAt = '2024-02-29'; assert.equal(sampleEditPayload(form, sample, options).receivedAt, '2024-02-29T00:00:00Z');
  options.allowReceivingDateEdit = false; assert(!Object.hasOwn(sampleEditPayload(form, sample, options), 'receivedAt'));
});

test('source special policies restrict header and product commands while keeping the source kind labels', () => {
  const { sample, options } = fixture();
  for (const [type, allowed] of [['quality_control', ['customerAddress']], ['amendment', ['customerId', 'customerQuotationId', 'customerAddress', 'modeOfReceipt', 'collectionDetails', 'amendmentRemarks']]]) {
    sample.sampleType = type; const policy = sampleFormEditPolicy(sample, options); assert.deepEqual([...policy.headers], allowed); assert.equal(policy.products, false);
    const form = sampleEditForm(sample); form.products = []; form.receivedAt = 'invalid'; form.customerAddress = 'changed';
    assert.deepEqual(sampleEditPayload(form, sample, options), { revision: 7, customerAddress: 'changed' });
  }
  assert.equal(sampleEditKind({ sampleType: 'internal' }), 'base');
  assert.equal(sampleEditKind({ sampleType: 'interlaboratory', ilcMode: 'participant' }), 'ilc_participation');
  assert.equal(sampleEditKind({ sampleType: 'quality_control', iqcType: 'int_lab' }), 'intralab');
});

test('complaint saves select existing IDs, remove unchecked rows and reject an empty selection', () => {
  const { sample, options } = fixture(); sample.sampleType = 'complaint'; sample.products[0].tests[0].isRetest = true;
  const unselected = { ...sample.products[0].tests[0], id: randomUUID(), isRetest: false }; sample.products[0].tests.push(unselected);
  const form = sampleEditForm(sample); const payload = sampleEditPayload(form, sample, options);
  assert.deepEqual(payload, { revision: 7, complaintRetestIds: [sample.products[0].tests[0].id] });
  form.products[0].tests[0].isRetest = false;
  assert.throws(() => sampleEditPayload(form, sample, options), { code: 'invalid_complaint_retest' });
});

test('retained choices only supplement the exact original selection and never override an active label', () => {
  const original = randomUUID(); const active = [{ value: randomUUID(), label: 'Active' }];
  assert.deepEqual(retainedSampleOption(active, original, original, 'Saved'), [...active, { value: original, label: 'Saved' }]);
  assert.equal(retainedSampleOption(active, original, undefined, 'Wrong row'), active);
  assert.equal(retainedSampleOption(active, active[0].value, active[0].value, 'Old label'), active);
});

test('edit date preview follows stable test IDs and receiving date, with category fallback and invalid bounds', () => {
  const { sample, options } = fixture(); const form = sampleEditForm(sample);
  form.products[0].tests[0].testParameterId = randomUUID();
  assert.equal(sampleEditReportingDate(form, sample, options).recalculated, false);
  form.products[0].tests[0] = { ...form.products[0].tests[0], id: undefined, key: randomUUID(), estimatedDurationDays: '' };
  assert.deepEqual(sampleEditReportingDate(form, sample, options), { dueAt: '2024-03-02', recalculated: true });
  form.receivedAt = '2024-02-29'; assert.equal(sampleEditReportingDate(form, sample, options).dueAt, '2024-03-03');
  form.products[0].tests[0].estimatedDurationDays = 1e300;
  assert.deepEqual(sampleEditReportingDate(form, sample, options), { dueAt: '2024-03-20', recalculated: false });
});

test('new rows have no inherited IDs, currency or nullable metadata from a row at the same position', () => {
  const { sample, options } = fixture(); const form = sampleEditForm(sample); const previous = sample.products[0];
  form.products = [{ ...newProduct(sample.sampleCategoryId), productId: previous.productId,
    tests: [{ ...newTest(), testParameterId: previous.tests[0].testParameterId, methodId: previous.tests[0].methodId, rate: '0' }] }];
  const payload = sampleEditPayload(form, sample, options); const selected = payload.products[0].tests[0];
  assert(!Object.hasOwn(payload.products[0], 'id')); assert(!Object.hasOwn(selected, 'id')); assert.equal(selected.currencyCode, 'INR');
  assert.equal(selected.requestedSize, null); assert.equal(selected.decisionRuleId, null);
});
