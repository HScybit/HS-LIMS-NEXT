import test from 'node:test';
import assert from 'node:assert/strict';
import { customerFormDraft, customerFormErrors, customerFormInput } from '../../src/masters/customer-form.js';

const draft = extra => customerFormDraft({ name: 'Customer', legalName: 'Customer Ltd', contactPersonName: 'Person', contactPersonEmail: 'person@example.invalid', contactPersonPhone: '123', ...extra });

test('Customer form retains source defaults and explicit zero, false and inactive status', () => {
  const initial = draft(); assert.equal(initial.creditDays, 30); assert.equal(initial.igstPercent, 18);
  assert.deepEqual(customerFormErrors(initial), {});
  const zeros = draft({ igstPercent: '0', creditDays: 0, feedbackApplicable: false, isKaleenBandhu: false, status: 'inactive' });
  assert.deepEqual(customerFormErrors(zeros), {});
  assert.equal(zeros.igstPercent, '0'); assert.equal(zeros.creditDays, 0); assert.equal(zeros.feedbackApplicable, false); assert.equal(zeros.status, 'inactive');
});

test('Customer numeric controls preserve precision and reject blanks, bounds and fractional days', () => {
  const values = draft({ totalBalance: '-12345678901234567.895', igstPercent: '0.123456789', creditDays: '0' });
  assert.deepEqual(customerFormErrors(values), {});
  const input = customerFormInput(values);
  assert.equal(input.totalBalance, values.totalBalance); assert.equal(input.igstPercent, values.igstPercent); assert.equal(input.creditDays, 0);
  for (const [key, value] of [['totalBalance',''],['sgstPercent','101'],['discountPercent','-1'],['creditDays','0.5'],['creditDays','3651'],['totalBalance','Infinity']]) {
    assert.ok(customerFormErrors(draft({ [key]: value }))[key]);
  }
  assert.ok(customerFormErrors({ ...values, igstPercent: null }).igstPercent);
  assert.equal(customerFormInput({ ...values, creditDays: '' }).creditDays, null);
});

test('Customer contact controls are required by the source form and validate email', () => {
  for (const key of ['name','legalName','contactPersonName','contactPersonEmail','contactPersonPhone']) assert.ok(customerFormErrors(draft({ [key]: '  ' }))[key]);
  assert.ok(customerFormErrors(draft({ contactPersonEmail: 'invalid' })).contactPersonEmail);
});
