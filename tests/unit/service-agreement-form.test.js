import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceAgreementFormDraft, serviceAgreementFormBody, serviceAgreementFormErrors } from '../../src/masters/service-agreement-form.js';
import { serviceAgreementDateDisplay } from '../../src/masters/service-agreement-fields.js';

const complete = () => ({ ...serviceAgreementFormDraft(), vendorId: 'chosen-vendor', instrumentIds: ['chosen-instrument'], startDate: '2026-01-01', endDate: '2026-12-31' });
test('Agreement forms preserve zero, false, dates and missing numeric defaults', () => {
  const blank = complete(); assert.deepEqual(serviceAgreementFormErrors(blank), {});
  const submitted = serviceAgreementFormBody(blank); assert.equal(submitted.cost, '0'); assert.equal(submitted.noOfServices, 0); assert.equal(submitted.inEffect, false);
  const existing = serviceAgreementFormDraft({ ...submitted, notes: null }); assert.equal(existing.cost, '0'); assert.equal(existing.noOfServices, 0); assert.equal(existing.inEffect, false); assert.equal(existing.notes, '');
  assert.equal(serviceAgreementDateDisplay('0001-01-01'), '01/01/0001'); assert.equal(serviceAgreementDateDisplay('9999-12-31'), '31/12/9999');
  const visible = { ...complete(), startDate: '31/12/2025', endDate: '01/01/2026' };
  assert.deepEqual(serviceAgreementFormErrors(visible), {});
  assert.equal(serviceAgreementFormBody(visible).startDate, '2025-12-31'); assert.equal(serviceAgreementFormBody(visible).endDate, '2026-01-01');
  assert(serviceAgreementFormErrors({ ...visible, startDate: '01/01/2026', endDate: '31/12/2025' }).endDate);
});
test('Agreement form validation rejects invalid calendar dates, counts, negative cost and selection bounds', () => {
  const blank = serviceAgreementFormErrors(serviceAgreementFormDraft()); assert.deepEqual(Object.keys(blank), ['vendorId', 'instrumentIds', 'startDate', 'endDate']);
  for (const date of ['0000-01-01', '2026-02-29', '2026-02-30']) assert(serviceAgreementFormErrors({ ...complete(), startDate: date }).startDate);
  assert(serviceAgreementFormErrors({ ...complete(), endDate: '2025-12-31' }).endDate);
  for (const count of ['-1', '1.5', 'Infinity', '2147483648']) assert(serviceAgreementFormErrors({ ...complete(), noOfServices: count }).noOfServices);
  for (const cost of ['-0.001', '-1e-400', 'NaN', '1,000']) assert(serviceAgreementFormErrors({ ...complete(), cost }).cost);
  assert(serviceAgreementFormErrors({ ...complete(), instrumentIds: Array(501).fill('chosen') }).instrumentIds);
  assert.deepEqual(serviceAgreementFormErrors({ ...complete(), instrumentIds: Array(500).fill('chosen'), noOfServices: '2147483647', cost: '0' }), {});
});
