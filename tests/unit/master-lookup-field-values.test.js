import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMasterCustomFieldValues } from '../../src/masters/master-custom-field-values.js';

const identity = { organization_id: randomUUID() };
const field = changes => ({ id: randomUUID(), revision: 1, key: 'place', label: 'Place', fieldType: 'lookup', lookupSourceId: randomUUID(), options: [], ...changes });
const entry = (definition, value) => ({ fieldId: definition.id, fieldRevision: definition.revision, value });
const observed = (sourceId, lineId, label, revision = 3) => ({ sourceId, lineId, revision, labelKind: typeof label === 'string' ? 'text' : typeof label,
  labelText: typeof label === 'string' ? label : null, labelNumber: typeof label === 'number' ? label : null, labelBoolean: typeof label === 'boolean' ? label : null });
function client(rows = []) {
  const calls = [];
  return { calls, async query(sql, args) {
    assert.match(sql, /JOIN custom_field_lookup_lines/); assert.match(sql, /source\.revision=line\.revision/);
    assert.doesNotMatch(sql, /user_custom_field_lookup_lines/); calls.push({ sql, args }); return { rows };
  } };
}
for (const kind of ['product', 'parameter']) {
  const prepare = (c, definitions, entries, previousFields = []) => prepareMasterCustomFieldValues(kind, c, identity, { definitions, entries, previousFields });
  test(`${kind} current lookup reads batch shared sources while keeping independent labels and raw types`, async () => {
    const first = field({ allowsMultiple: true }); const second = field({ key: 'other' }); const third = field({ key: 'shared', lookupSourceId: first.lookupSourceId });
    const c = client([observed(first.lookupSourceId, 'A', 'First A'), observed(first.lookupSourceId, '0', 0), observed(first.lookupSourceId, 'false', false), observed(second.lookupSourceId, 'A', 'Other A', 7)]);
    const result = await prepare(c, [first, second, third], [entry(first, ['A', 'A', 0, false]), entry(second, 'A'), entry(third, 0)]);
    assert.equal(c.calls.length, 1); assert.deepEqual(c.calls[0].args, [identity.organization_id,
      [first.lookupSourceId, first.lookupSourceId, first.lookupSourceId, second.lookupSourceId], ['A', '0', 'false', 'A']]);
    assert.deepEqual(result.items.map(item => [item.rawKind, item.lookupLineId, item.lookupRevision]),
      [['text', 'A', 3], ['text', 'A', 3], ['number', '0', 3], ['boolean', 'false', 3], ['text', 'A', 7], ['number', '0', 3]]);
    assert.equal(result.fields[0].displayText, 'First A, First A'); assert.equal(result.fields[1].displayText, 'Other A');
    assert.equal(result.fields[2].displayKind, 'number'); assert.equal(result.fields[2].displayNumber, 0);
  });
  test(`${kind} unavailable lookup retention follows only the previous saved key and exact primitive`, async () => {
    const current = field(); const previous = { fieldId: randomUUID(), key: current.key, items: [{ value: false }] };
    const result = await prepare(client(), [current], [entry(current, false)], [previous]);
    assert.equal(result.items[0].interpretationState, 'invalid');
    assert.deepEqual([result.items[0].lookupSourceId, result.items[0].lookupRevision, result.items[0].lookupLineId], [null, null, null]);
    for (const [value, prior] of [['false', [previous]], [false, []], [false, [{ ...previous, key: 'different' }]]]) {
      await assert.rejects(prepare(client(), [current], [entry(current, value)], prior), { code: `invalid_${kind}_custom_field_lookup` });
    }
    const restored = await prepare(client([observed(current.lookupSourceId, 'false', 'Restored', 8)]), [current], [entry(current, false)], [previous]);
    assert.equal(restored.items[0].lookupRevision, 8); assert.equal(restored.fields[0].displayText, 'Restored');
  });
  test(`${kind} empty lookups skip reads and inconsistent observations cannot become capture references`, async () => {
    const current = field(); const c = client();
    const empty = await prepare(c, [current], [entry(current, '')]); assert.equal(c.calls.length, 0);
    assert.equal(empty.items[0].interpretationState, 'empty'); assert.equal(empty.items[0].lookupSourceId, null);
    const row = observed(current.lookupSourceId, 'A', 'A');
    for (const rows of [[row, row], [observed(randomUUID(), 'A', 'Foreign')], [observed(current.lookupSourceId, 'B', 'Unrequested')]]) {
      await assert.rejects(prepare(client(rows), [current], [entry(current, 'A')]), { code: `incomplete_${kind}_custom_fields` });
    }
  });
}
