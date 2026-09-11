import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newRegistration, newProduct, newTest, changeSampleKind, registrationPayload, testSelection, productParameters, availableMethods, estimatedAmount, estimatedReportingDate } from '../../src/samples/form.js';
import { quickCustomerInput } from '../../src/samples/input.js';

function fixture() {
  const categoryId = randomUUID(); const productId = randomUUID(); const parameterId = randomUUID(); const methodId = randomUUID();
  const options = { sampleCategories: [{ id: categoryId, estimatedTimeInDays: 4 }], testParameters: [{ id: parameterId, methods: [{ id: methodId, isDefault: true }] }],
    decisionRules: [{ id: randomUUID(), name: 'Specific rule', productId, testParameterId: parameterId, methodId, sampleCategoryId: categoryId, estimatedTimeInDays: '2.5', estimatedCharges: '0', minimumSize: '10 mL', isNabl: false }] };
  const form = newRegistration('base', 'Synthetic analyst', new Date('2026-09-12T12:00:00Z'));
  form.customerId = randomUUID(); form.customerAddress = 'Synthetic address'; form.receivedAt = '2026-09-12';
  const product = form.products[0]; Object.assign(product, { productId, sampleCategoryId: categoryId, quantity: '1.25' });
  Object.assign(product.tests[0], testSelection(options, product, parameterId));
  return { form, options, product, categoryId, parameterId, methodId };
}

test('routed PERN method defaults use applicable criteria and favor method/category specificity', () => {
  const { options, product, methodId, parameterId } = fixture();
  const excluded = randomUUID(); options.testParameters[0].methods.unshift({ id: excluded, isDefault: true });
  const generic = { ...options.decisionRules[0], id: randomUUID(), name: 'A generic criterion', sampleCategoryId: null, estimatedCharges: '90' };
  options.decisionRules.unshift(generic);
  assert.deepEqual(availableMethods(options, product, parameterId).map((method) => method.id), [methodId]);
  assert.equal(testSelection(options, product, parameterId).rate, '0');
  assert.equal(testSelection(options, product, parameterId).requestedSize, '10 mL');
  assert.equal(productParameters(options, { ...product, productId: randomUUID() }).length, 0);
  assert.equal(testSelection(options, product, '').methodId, '');
});

test('registration keeps zero/false, stable dates, summed quantity and strips transient UI identity', () => {
  const { form, options, product } = fixture(); product.tests[0].rate = '125'; form.totalAmount = '0';
  assert.equal(estimatedAmount(form.products, form.kind), 125);
  const payload = registrationPayload(form, options);
  assert.equal(payload.totalAmount, '0'); assert.equal(payload.products[0].tests[0].isAccredited, false);
  assert.equal(payload.quantity, '1.25'); assert.equal(payload.receivedAt, '2026-09-12T00:00:00.000Z');
  assert.equal(payload.dueAt, '2026-09-14T00:00:00.000Z');
  assert.equal(payload.products[0].tests[0].estimatedDurationMinutes, 1200);
  assert.equal(Object.hasOwn(payload.products[0], 'key'), false);
  assert.equal(Object.hasOwn(payload.products[0].tests[0], 'key'), false);
  product.tests[0].rate = ''; assert.equal(registrationPayload(form, options).products[0].tests[0].rate, null);
  assert.equal(registrationPayload(form, options).products[0].tests[0].currencyCode, null);
});

test('reporting dates use the receiving date, positive test estimates, category fallback and explicit override', () => {
  const { form, options, product } = fixture();
  assert.equal(estimatedReportingDate(form, options), '2026-09-14');
  product.tests[0].estimatedDurationDays = '0'; assert.equal(estimatedReportingDate(form, options), '2026-09-16');
  form.dueAt = '2026-10-01'; assert.equal(registrationPayload(form, options).dueAt, '2026-10-01T00:00:00.000Z');
  form.dueAt = '2026-09-10'; assert.throws(() => registrationPayload(form, options), /earlier/);
  form.receivedAt = '2026-02-30'; assert.equal(estimatedReportingDate(form, options), '');
  assert.throws(() => registrationPayload(form, options), /calendar/);
});

test('special kinds normalize aliases, discard irrelevant variant data and keep only complaint retests', () => {
  const { form, options, product } = fixture();
  assert.equal(newRegistration('is_ilc_sample').kind, 'ilc');
  form.kind = 'intralab'; form.participantCount = '3';
  assert.equal(registrationPayload(form, options).iqcType, 'int_lab');
  form.kind = 'base'; assert.equal(registrationPayload(form, options).participantCount, null);
  form.kind = 'ilc'; form.participatingLabs = [{ laboratoryName: '  ' }, { laboratoryName: ' Synthetic lab ' }];
  assert.deepEqual(registrationPayload(form, options).participatingLabs, [{ laboratoryName: 'Synthetic lab' }]);
  form.kind = 'pt'; assert.deepEqual(registrationPayload(form, options).participatingLabs, []);
  form.kind = 'complaint'; product.tests[0].isRetest = true; product.tests.push(newTest()); form.products.push(newProduct());
  const payload = registrationPayload(form, options); assert.equal(payload.products.length, 1); assert.equal(payload.products[0].tests.length, 1);
  product.tests[0].isRetest = false; assert.throws(() => registrationPayload(form, options));
});

test('changing sample kind clears hidden variant data without losing customer or product input', () => {
  const { form } = fixture();
  Object.assign(form, { kind: 'ilc', participatingLabs: [{ laboratoryName: 'Synthetic lab' }], iqcType: 'retest', participantCount: '3',
    amendmentRemarks: 'Old amendment', complaintRemarks: 'Old complaint' });
  const intra = changeSampleKind(form, 'intralab');
  assert.equal(intra.iqcType, 'int_lab'); assert.equal(intra.participantCount, '3');
  assert.deepEqual(intra.participatingLabs, []); assert.equal(intra.amendmentRemarks, ''); assert.equal(intra.complaintRemarks, '');
  const base = changeSampleKind(intra, 'base');
  assert.equal(base.iqcType, ''); assert.equal(base.participantCount, '');
  assert.deepEqual(changeSampleKind(base, 'ilc').participatingLabs, []);
  assert.equal(base.customerId, form.customerId); assert.equal(base.products, form.products);
});

test('cleared, duplicate and nonfinite selections fail before submission', () => {
  const { form, options, product } = fixture(); product.tests.push({ ...product.tests[0], key: randomUUID() });
  assert.throws(() => registrationPayload(form, options), /twice/);
  product.tests.pop(); product.tests[0].methodId = ''; assert.throws(() => registrationPayload(form, options), /Method/);
  product.tests[0].methodId = randomUUID(); product.quantity = 'Infinity'; assert.throws(() => registrationPayload(form, options), /finite/);
});

test('quick customer validates all source fields, email and unsupported properties', () => {
  const input = { name: ' Synthetic ', legalName: 'Synthetic legal name', contactPersonName: 'Contact', contactPersonEmail: 'a@example.invalid', contactPersonPhone: '00000', billToAddress: 'A\nB', shipToAddress: 'C' };
  assert.equal(quickCustomerInput(input).name, 'Synthetic');
  assert.equal(quickCustomerInput(input).billToAddress, 'A\nB');
  assert.throws(() => quickCustomerInput({ ...input, contactPersonPhone: '' }));
  assert.throws(() => quickCustomerInput({ ...input, contactPersonEmail: 'invalid' }), /email/);
  assert.throws(() => quickCustomerInput({ ...input, organizationId: randomUUID() }), /unsupported/);
});
