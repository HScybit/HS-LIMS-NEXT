import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleParameterTitleFields, loadParameterTitleFields } from '../../src/datasheets/parameter-title-fields.js';

const header = { parameterId: 'parameter', parameterRevision: 2, parameterHistoryAvailable: true, parameterCustomFieldCount: 1, testRequestId: 'request' };
const selection = (title = 'project_field_data') => new Map([['request', { all: title === 'project_field_data', keys: new Set(title.includes('.') ? [title.split('.').at(-1)] : []), titles: new Map([[title, 1]]) }]]);
const field = { ...header, fieldId: 'field', fieldRevision: 3, fieldType: 'number', key: 'zero', label: 'Captured label',
  valueCount: 1, isArray: false, displayKind: 'number', displayNumber: 0, paddedNumber: 0, splitter: '/', scheme: '' };
const value = { ...header, fieldId: 'field', position: 0, rawKind: 'boolean', rawBoolean: false };

test('historical field assembly preserves raw/display differences, arrays and own keys with no prototype lookup', () => {
  const versions = new Map([['parameter:2', header]]);
  const maps = assembleParameterTitleFields(versions, [field], [value]);
  assert.equal(maps.get('parameter:2').zero.value, false); assert.equal(maps.get('parameter:2').zero.display_value, 0);
  assert.equal(Object.getPrototypeOf(maps.get('parameter:2')), null);
  const array = { ...field, key: '__proto__', isArray: true, valueCount: 2, displayKind: 'text', displayText: '0, false' };
  const result = assembleParameterTitleFields(versions, [array], [{ ...value, rawKind: 'number', rawNumber: 0 }, { ...value, position: 1 }]);
  assert.deepEqual(result.get('parameter:2').__proto__.value, [0, false]);
  for (const [fields, values] of [[[field], []], [[field, field], [value]], [[field], [{ ...value, position: 1 }]],
    [[field], [{ ...value, rawKind: 'number', rawNumber: Infinity }]], [[{ ...field, valueCount: 0 }], []]]) {
    assert.throws(() => assembleParameterTitleFields(versions, fields, values), { code: 'incomplete_parameter_title_history' });
  }
});

test('absent history and empty captured definitions do not query or fabricate old fields', async () => {
  const client = { query: () => assert.fail('No field query is needed') };
  const absent = await loadParameterTitleFields(client, {}, [{ ...header, parameterHistoryAvailable: false }], selection());
  assert.equal(absent.fieldsByRequestId.size, 0);
  const empty = await loadParameterTitleFields(client, {}, [{ ...header, parameterCustomFieldCount: 0 }], selection());
  assert.equal(empty.metrics.queryCount, 0); assert.deepEqual(Object.keys(empty.fieldsByRequestId.get('request')), []);
  const invalidKey = await loadParameterTitleFields(client, {}, [header], selection('prefix.invalid-key'));
  assert.equal(invalidKey.metrics.queryCount, 0);
});

test('count and byte admission fails before loading oversized field text or values', async () => {
  for (const budget of [{ fields: '1', values: '1', bytes: String(16 * 1024 * 1024 + 1) },
    { fields: '50001', values: '1', bytes: '0' }, { fields: '1', values: '500001', bytes: '0' }]) {
    let queries = 0;
    const client = { query: async () => { queries += 1; assert.equal(queries, 1); return { rows: [{ ...header, ...budget }] }; } };
    await assert.rejects(loadParameterTitleFields(client, {}, [header], selection()), { code: 'parameter_title_size_limit' });
  }
});

test('shared revisions load once while expanded title text and incomplete whole maps are bounded', async () => {
  const requests = selection('prefix.zero'); requests.set('second', requests.get('request'));
  let queries = 0;
  const client = { query: async () => ({ rows: [
    [{ ...header, fields: '1', values: '1', bytes: '14' }], [field], [value],
  ][queries++] }) };
  const loaded = await loadParameterTitleFields(client, {}, [header, { ...header, testRequestId: 'second' }], requests);
  assert.equal(queries, 3); assert.equal(loaded.fieldsByRequestId.get('request'), loaded.fieldsByRequestId.get('second'));
  const large = selection('prefix.zero'); large.get('request').titles.set('prefix.zero', 16 * 1024 * 1024 + 1); queries = 0;
  await assert.rejects(loadParameterTitleFields(client, {}, [header], large), { code: 'parameter_title_size_limit' });
  await assert.rejects(loadParameterTitleFields({ query: async () => ({ rows: [] }) }, {}, [header], selection()), { code: 'incomplete_parameter_title_history' });
});
