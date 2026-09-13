import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { productInput } from '../../src/masters/products.js';

const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Water', key: 'WATER/01', ...changes });

test('product input retains authored description, zero text and ordered identities', () => {
  const first = randomUUID(); const second = randomUUID(); const template = randomUUID();
  const value = input({ name: ' Water ', key: ' Water/01 ', description: ' 0\n ', abbreviation: ' 0 ',
    tagIds: [second.toUpperCase(), first], jobTemplateId: template.toUpperCase() });
  const result = productInput({ ...value, id: value.id.toUpperCase(), requestId: value.requestId.toUpperCase() });
  assert.equal(result.id, value.id); assert.equal(result.requestId, value.requestId);
  assert.equal(result.name, 'Water'); assert.equal(result.key, 'Water/01'); assert.equal(result.description, ' 0\n ');
  assert.equal(result.abbreviation, '0'); assert.equal(result.jobTemplateId, template); assert.deepEqual(result.tagIds, [second, first]);
});

test('optional product values distinguish nullable abbreviation and explicit blank text', () => {
  const absent = productInput(input());
  assert.equal(absent.description, ''); assert.equal(absent.abbreviation, null); assert.equal(absent.jobTemplateId, null); assert.deepEqual(absent.tagIds, []);
  const empty = productInput(input({ description: null, abbreviation: '', jobTemplateId: '' }));
  assert.equal(empty.description, ''); assert.equal(empty.abbreviation, ''); assert.equal(empty.jobTemplateId, null);
  assert.equal(productInput(input({ abbreviation: null })).abbreviation, null);
});

test('visible product keys are validated without silently changing or truncating them', () => {
  assert.equal(productInput(input({ key: 'a'.repeat(64) })).key.length, 64);
  for (const key of ['a'.repeat(65), '', '  ', 'a b', '_key', 'a\0b', 'a%']) assert.throws(() => productInput(input({ key })), { status: 400 });
  for (const key of ['0', 'Ab._/-12']) assert.equal(productInput(input({ key })).key, key);
});

test('product tags reject null, duplicates after normalization and oversized lists', () => {
  const tags = Array.from({ length: 500 }, () => randomUUID());
  assert.deepEqual(productInput(input({ tagIds: tags })).tagIds, tags);
  for (const tagIds of [null, {}, '', [...tags, randomUUID()], [tags[0], tags[0].toUpperCase()]]) {
    assert.throws(() => productInput(input({ tagIds })), { code: 'invalid_product_tags' });
  }
  assert.throws(() => productInput(input({ tagIds: ['missing'] })), { code: 'invalid_id' });
});

test('product input rejects hidden links, malformed identities and invalid text or revisions', () => {
  for (const changes of [{ sampleCategoryIds: [] }, { active: false }, { name: null }, { name: 'x'.repeat(201) },
    { name: 'a\0b' }, { description: false }, { description: 'x'.repeat(16001) }, { description: 'a\0b' },
    { abbreviation: 0 }, { abbreviation: 'x'.repeat(65) }, { abbreviation: 'a\0b' }, { id: 'missing' },
    { requestId: null }, { jobTemplateId: 0 }, { revision: null }, { revision: -1 }, { revision: 1.5 }, { revision: 2_147_483_647 }]) {
    assert.throws(() => productInput(input(changes)), { status: 400 });
  }
});

test('Product capture input distinguishes omission from replacement and rejects client interpretation metadata', () => {
  const absent = productInput(input()); assert.equal(absent.customFieldsProvided, false); assert.equal(absent.customFields, undefined);
  const empty = productInput(input({ customFields: [] })); assert.equal(empty.customFieldsProvided, true); assert.deepEqual(empty.customFields, []);
  const fieldId = randomUUID();
  const value = productInput(input({ customFields: [{ fieldId: fieldId.toUpperCase(), fieldRevision: 2, value: [false, 0, ' ', '01.00'] }], customFieldTimeZone: 'america/new_york' }));
  assert.equal(value.customFieldTimeZone, 'America/New_York');
  assert.deepEqual(value.customFields, [{ fieldId, fieldRevision: 2, value: [false, 0, '01.00'] }]);
  for (const changes of [{ customFields: undefined }, { customFields: null }, { customFieldsProvided: true }, { customFieldCount: 1 },
    { customFieldTimeZone: 'UTC' }, { customFields: [], customFieldTimeZone: 'constructor' },
    { customFields: [{ fieldId, fieldRevision: 1, value: 0, rawNumberText: 'forged' }] }]) {
    assert.throws(() => productInput(input(changes)), { status: 400 });
  }
});
