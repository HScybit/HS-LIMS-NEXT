import test from 'node:test';
import assert from 'node:assert/strict';
import { vendorFormDraft, vendorFormErrors } from '../../src/masters/vendor-form.js';

const draft = extra => vendorFormDraft({ name: 'Vendor', legalName: 'Vendor Ltd', contactPersonName: 'Person', contactPersonEmail: 'person@example.invalid', contactPersonPhone: '123', ...extra });

test('Vendor form retains eight source fields, default zero and exact decimal text', () => {
  const initial = draft(); assert.equal(Object.keys(initial).length, 8); assert.equal(initial.totalBalance, 0); assert.deepEqual(vendorFormErrors(initial), {});
  const exact = draft({ totalBalance: '-9007199254740993.125', status: 'inactive' });
  assert.equal(exact.totalBalance, '-9007199254740993.125'); assert.deepEqual(vendorFormErrors(exact), {});
  assert.equal(Object.hasOwn(exact, 'status'), false);
  for (const totalBalance of ['', 'Infinity', 'NaN']) assert.ok(vendorFormErrors(draft({ totalBalance })).totalBalance);
});

test('Vendor contact controls require name, email and phone and validate email', () => {
  for (const key of ['name', 'legalName', 'contactPersonName', 'contactPersonEmail', 'contactPersonPhone']) assert.ok(vendorFormErrors(draft({ [key]: '  ' }))[key]);
  assert.ok(vendorFormErrors(draft({ contactPersonEmail: 'invalid' })).contactPersonEmail);
});
