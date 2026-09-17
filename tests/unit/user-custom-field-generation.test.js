import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userGenerationInput } from '../../src/users/custom-field-generation.js';
import { userCustomFieldGenerationPayload, userCustomFieldGeneratedValues } from '../../src/users/custom-field-form.js';
import { generateUserScheme } from '../../src/custom-fields/product-generation.js';
import { runMasterGeneration } from '../../src/custom-fields/product-generation-runner.js';

const field = { id: randomUUID(), revision: 2, key: 'code', label: 'Code', fieldType: 'text', scheme: '{{total_counter}}', generatedAt: 'on_init' };
const input = () => ({ user: {}, customFields: [{ fieldId: field.id, fieldRevision: 2, value: '' }] });
const clock = { year: 2026, month: 3, day: 1, timestamp: 123 };

test('User generation payload projects only ordinary draft fields, preserves raw zero/false and never sends secrets', () => {
  const userId = randomUUID(); const managerId = randomUUID();
  const draft = { displayName: ' Unfinished name ', email: 'unfinished', username: '', canManagePeople: false,
    reportingManagerId: managerId, password: 'Never transmit', user_sign: 'Secret bytes', credentials: { hash: 'secret' } };
  const created = userCustomFieldGenerationPayload([field], { pf_code: 0 }, draft);
  assert.equal(created.user.displayName, draft.displayName); assert.equal(created.customFields[0].value, 0);
  for (const key of ['password', 'user_sign', 'credentials', 'reportingManagerId']) assert.equal(Object.hasOwn(created.user, key), false);
  const edited = userCustomFieldGenerationPayload([field], { pf_code: false }, draft, { userId, fieldId: field.id });
  assert.equal(edited.user.reportingManagerId, managerId); assert.equal(edited.customFields[0].value, false);
  assert.deepEqual(userCustomFieldGenerationPayload([], {}, {} ).customFields, []);
  const parsed = userGenerationInput(edited);
  assert.equal(parsed.doc.name, draft.displayName); assert.equal(parsed.doc.can_be_manager, false);
  assert.equal(parsed.doc.reporting_manager_id, managerId); assert.equal(Object.hasOwn(parsed.doc, 'password'), false);
});

test('User generation rejects injected properties, invalid text/IDs/booleans and duplicate or oversized field input', () => {
  for (const value of [null, [], {}, { ...input(), password: 'secret' }, { ...input(), user: { password: 'secret' } },
    { ...input(), user: { profile: {} } }, { ...input(), user: { phone: 'x'.repeat(51) } }, { ...input(), user: { displayName: '\0' } },
    { ...input(), user: { email: '\ud800' } }, { ...input(), user: { canManagePeople: 'false' } },
    { ...input(), user: { laboratoryId: 'bad' } }, { ...input(), user: { reportingManagerId: randomUUID() } },
    { ...input(), userId: 'bad' }, { ...input(), fieldId: 'bad' }, { ...input(), customFields: [input().customFields[0], input().customFields[0]] }]) {
    assert.throws(() => userGenerationInput(value), error => error.status === 400);
  }
  const parsed = userGenerationInput({ ...input(), user: { businessUnitId: randomUUID().toUpperCase(), defaultRoleId: null } });
  assert.equal(parsed.doc.unit_id, parsed.doc.unit_id.toLowerCase()); assert.equal(parsed.doc.default_role, '');
  assert.equal(Object.hasOwn(parsed.doc, 'business_unit_id'), false);
});

test('generated values update current key identities without mutating drafts or accepting unknown fields', () => {
  const values = Object.freeze({ pf_code: '', pf_other: 'keep' });
  assert.deepEqual(userCustomFieldGeneratedValues([field], values, [{ fieldId: field.id, value: 'U/1' }]), { pf_code: 'U/1', pf_other: 'keep' });
  assert.throws(() => userCustomFieldGeneratedValues([field], values, [{ fieldId: randomUUID(), value: 'bad' }]));
  assert.throws(() => userCustomFieldGeneratedValues([field], values, [{ fieldId: field.id, value: null }]));
});

test('User schemes retain source tokens and tenant counters without hidden scientific or credential context', async () => {
  const command = userGenerationInput({ ...input(), user: { displayName: 'Name', businessUnitId: randomUUID(), canManagePeople: false } });
  const value = await generateUserScheme({ field: { ...field, scheme: '{{entity.name}}/{{entity.can_be_manager}}/{{total_counter}}/{{samples_counter}}/{{financial_year}}/{{business_unit}}/{{product_name}}/{{entity.password}}/{{entity.constructor.name}}' },
    doc: command.doc, clock, counts: { users: 5, samples: 2 }, settings: {}, latestValue: async () => { throw new Error('Unexpected counter scan'); } });
  assert.equal(value, 'Name/false/6/3/25-26////');
});

test('User worker generates create/submit fields in order, keeps zero/false and permits explicit on-demand refresh', async () => {
  const fields = [field, { ...field, id: 'copy', key: 'copy', scheme: '{{code}}/copy', generatedAt: 'on_submit' },
    { ...field, id: 'manual', key: 'manual', scheme: 'demand', generatedAt: 'on_demand' }];
  const data = { kind: 'user', fields, values: { [field.id]: '', copy: '', manual: '' },
    doc: { project_field_data: Object.fromEntries(fields.map(f => [f.key, { value: '', display_value: '' }])) },
    counts: { users: 2, samples: 0 }, settings: {}, clock, timeZone: null, mode: 'create' };
  const noRead = async () => { throw new Error('Unexpected database scan'); };
  assert.deepEqual(await runMasterGeneration(data, noRead), [{ fieldId: field.id, value: '3' }, { fieldId: 'copy', value: '3/copy' }]);
  assert.deepEqual(await runMasterGeneration({ ...data, mode: 'edit' }, noRead), [{ fieldId: 'copy', value: '/copy' }]);
  assert.deepEqual(await runMasterGeneration({ ...data, values: { [field.id]: 0, copy: false, manual: '' } }, noRead), []);
  assert.deepEqual(await runMasterGeneration({ ...data, fieldId: 'manual' }, noRead), [{ fieldId: 'manual', value: 'demand' }]);
});

test('generated lookup selections resolve current labels before dependent schemes and propagate lookup failures', async () => {
  const data = { kind: 'user', resolveLookups: true, fields: [{ ...field, id: 'lookup', key: 'lookup', fieldType: 'lookup', lookupSourceId: 'source', scheme: 'A' },
    { ...field, id: 'copy', key: 'copy', scheme: '{{lookup}}' }], values: { lookup: '', copy: '' }, doc: { project_field_data: { lookup: {}, copy: {} } },
    counts: { users: 0, samples: 0 }, settings: {}, clock, timeZone: null, mode: 'create' };
  const noPage = async () => { throw new Error('Unexpected counter scan'); };
  assert.deepEqual(await runMasterGeneration(data, noPage, { readLookup: async (id, value) => {
    assert.equal(id, 'lookup'); assert.equal(value, 'A'); return [{ value: 'A', label: 'Alpha' }];
  } }), [{ fieldId: 'lookup', value: 'A' }, { fieldId: 'copy', value: 'Alpha' }]);
  const failure = new Error('Synthetic lookup failure');
  await assert.rejects(runMasterGeneration(data, noPage, { readLookup: async () => { throw failure; } }), error => error === failure);
});
