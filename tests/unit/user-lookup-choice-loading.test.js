import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { loadUserFieldLookupSources } from '../../src/users/custom-field-lookup-client.js';
import { loadUserFieldLookupOptions } from '../../src/users/custom-fields.js';

const organizationId = randomUUID(); const identity = { organization_id: organizationId, permission_codes: ['users.read'] };
const field = sourceId => ({ fieldType: 'lookup', lookupSourceId: sourceId });
const source = (options = [], revision = 1) => ({ organizationId, revision, options });
const requestedId = path => new URL(path, 'http://localhost').searchParams.get('sourceId');

test('lookup loading deduplicates shared sources, keeps complete arrays and removes unused catalogs', async () => {
  const a = randomUUID(); const b = randomUUID(); const unused = randomUUID(); const calls = [];
  const options = Array.from({ length: 10000 }, (_, index) => ({ value: String(index), label: index }));
  const previous = new Map([[unused, source([{ value: 'old', label: 'Old' }])]]);
  const result = await loadUserFieldLookupSources([field(a), field(a), field(b), field(null), { fieldType: 'text', lookupSourceId: unused }], previous,
    { request: async path => { const sourceId = requestedId(path); calls.push(sourceId); return { sourceId, ...source(sourceId === a ? options : []) }; } });
  assert.deepEqual(calls, [a, b]); assert.deepEqual([...result.keys()], [a, b]); assert.equal(result.get(a).options, options);
  assert.equal(result.get(a).options.length, 10000); assert.equal(previous.size, 1); assert(previous.has(unused));
  assert.equal(result.get(a).selectOptions.sourceOptions, options); assert.equal(result.get(a).selectOptions.byValue.size, 10000);
  assert.equal(result.get(a).selectOptions.byValue.get('9999'), result.get(a).selectOptions.options[9999]);
});

test('catalog refresh reuses prepared choices only for the actual unchanged source revision', async () => {
  const id = randomUUID(); const options = [{ value: 'original', label: 'Before' }];
  const first = await loadUserFieldLookupSources([field(id), field(id)], new Map(), { request: async () => ({ sourceId: id, ...source(options, 1) }) });
  const reused = await loadUserFieldLookupSources([field(id)], first, { request: async () => ({ sourceId: id, organizationId, revision: 1, unchanged: true }) });
  assert.equal(reused.get(id).selectOptions, first.get(id).selectOptions);
  const changed = await loadUserFieldLookupSources([field(id)], first, { request: async () => ({ sourceId: id, ...source([{ value: 'original', label: 'After' }], 2) }) });
  assert.notEqual(changed.get(id).selectOptions, first.get(id).selectOptions);
  assert.equal(changed.get(id).selectOptions.byValue.get('original').label, 'After'); assert.equal(first.get(id).selectOptions.byValue.get('original').label, 'Before');
});

test('unchanged catalogs reuse their exact option arrays only within the matching organization and revision', async () => {
  const id = randomUUID(); const previous = new Map([[id, source([{ value: 'zero', label: 0 }, { value: 'false', label: false }], 4)]]);
  const result = await loadUserFieldLookupSources([field(id)], previous, { request: async path => {
    const query = new URL(path, 'http://localhost').searchParams; assert.equal(query.get('revision'), '4'); assert.equal(query.get('knownOrganizationId'), organizationId);
    return { organizationId, sourceId: id, revision: 4, unchanged: true };
  } });
  assert.equal(result.get(id), previous.get(id)); assert.equal(result.get(id).options[1].label, false);
  const otherOrganization = randomUUID();
  const changed = await loadUserFieldLookupSources([field(id)], previous, { request: async () => ({ organizationId: otherOrganization, sourceId: id, revision: 4, options: [{ value: 'zero', label: 'Other' }] }) });
  assert.equal(changed.get(id).organizationId, otherOrganization); assert.equal(changed.get(id).options[0].label, 'Other');
});

test('empty and unconfigured forms perform no lookup requests', async () => {
  for (const fields of [[], [field(null)], [{ fieldType: 'text', lookupSourceId: randomUUID() }]]) {
    const result = await loadUserFieldLookupSources(fields, new Map(), { request: () => assert.fail('No lookup request expected') });
    assert.equal(result.size, 0);
  }
});

test('catalog loading has at most four requests in flight and preserves source order after out-of-order replies', async () => {
  const ids = Array.from({ length: 9 }, () => randomUUID()); const pending = []; let active = 0; let maximum = 0;
  const request = path => new Promise(resolve => {
    const sourceId = requestedId(path); active++; maximum = Math.max(maximum, active);
    pending.push(() => { active--; resolve({ sourceId, ...source([{ value: sourceId, label: sourceId }]) }); });
  });
  const loading = loadUserFieldLookupSources(ids.map(field), new Map(), { request }); assert.equal(pending.length, 4);
  pending[3](); pending[1](); pending[0](); await tick(); assert.equal(pending.length, 4);
  pending[2](); await tick(); assert.equal(pending.length, 8);
  for (const index of [7, 5, 6, 4]) pending[index](); await tick(); assert.equal(pending.length, 9); pending[8]();
  const result = await loading; assert.equal(maximum, 4); assert.equal(active, 0); assert.deepEqual([...result.keys()], ids);
});

test('cancellation ignores even successful late replies and leaves the prior cache untouched', async () => {
  const ids = Array.from({ length: 5 }, () => randomUUID()); const previous = new Map([[ids[0], source([], 2)]]); const old = previous.get(ids[0]);
  const controller = new AbortController(); const pending = []; let count = 0;
  const loading = loadUserFieldLookupSources(ids.map(field), previous, { signal: controller.signal, request: (path, { signal }) => {
    assert.equal(signal, controller.signal); count++; return new Promise(resolve => pending.push(() => resolve({ sourceId: requestedId(path), ...source() })));
  } });
  const rejected = assert.rejects(loading, { name: 'AbortError' }); controller.abort(); pending.forEach(resolve => resolve()); await rejected;
  assert.equal(count, 4); assert.equal(previous.size, 1); assert.equal(previous.get(ids[0]), old);
});

test('one failed catalog never publishes partial results or requests later batches', async () => {
  const ids = Array.from({ length: 5 }, () => randomUUID()); const previous = new Map([[ids[0], source([], 2)]]); let count = 0;
  await assert.rejects(loadUserFieldLookupSources(ids.map(field), previous, { request: async path => {
    count++; if (requestedId(path) === ids[1]) throw new Error('Synthetic catalog failure');
    return { sourceId: requestedId(path), ...source() };
  } }), /Synthetic catalog failure/);
  assert.equal(count, 4); assert.equal(previous.size, 1); assert.equal(previous.get(ids[0]).revision, 2);
});

test('inconsistent unchanged markers and mismatched sources are rejected', async () => {
  const id = randomUUID(); const prior = new Map([[id, source([], 2)]]);
  for (const result of [
    { sourceId: randomUUID(), ...source() }, { sourceId: id, revision: 2 },
    { sourceId: id, organizationId, revision: 3, unchanged: true },
    { sourceId: id, organizationId: randomUUID(), revision: 2, unchanged: true },
  ]) await assert.rejects(loadUserFieldLookupSources([field(id)], prior, { request: async () => result }), /Lookup choices changed/);
  await assert.rejects(loadUserFieldLookupSources([field(id)], new Map(), { request: async () => ({ sourceId: id, organizationId, revision: 2, unchanged: true }) }), /Lookup choices changed/);
});

function catalogClient(rows, revision = 3) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); return { rows: calls.length === 1 ? revision === null ? [] : [{ revision }] : rows }; } };
}
const line = (position, kind, value, revision = 3) => ({ value: `original-${position}`, revision, position, kind, text: null, number: null, boolean: null, [kind]: value });

test('catalog reads return ordered full choices with exact primitive labels and a bounded second query', async () => {
  const id = randomUUID(); const client = catalogClient([line(0, 'text', ''), line(1, 'number', 0), line(2, 'boolean', false)]);
  const result = await loadUserFieldLookupOptions(client, identity, { sourceId: id.toUpperCase() });
  assert.deepEqual(result, { organizationId, sourceId: id, revision: 3, options: [{ value: 'original-0', label: '' }, { value: 'original-1', label: 0 }, { value: 'original-2', label: false }] });
  assert.equal(client.calls.length, 2); assert.deepEqual(client.calls[1].args, [organizationId, id, 3, 10001]);
});

test('unavailable and unchanged catalogs use one read while a foreign cache scope gets current local choices', async () => {
  const id = randomUUID(); const empty = catalogClient([], null);
  assert.deepEqual(await loadUserFieldLookupOptions(empty, identity, { sourceId: id, revision: 3, knownOrganizationId: organizationId }), { organizationId, sourceId: id, revision: null, options: [] });
  assert.equal(empty.calls.length, 1);
  const same = catalogClient([]);
  assert.deepEqual(await loadUserFieldLookupOptions(same, identity, { sourceId: id, revision: 3, knownOrganizationId: organizationId }), { organizationId, sourceId: id, revision: 3, unchanged: true });
  assert.equal(same.calls.length, 1);
  for (const knownOrganizationId of [undefined, randomUUID()]) {
    const current = catalogClient([line(0, 'text', 'Current')]);
    assert.equal((await loadUserFieldLookupOptions(current, identity, { sourceId: id, revision: 3, knownOrganizationId })).options[0].label, 'Current');
    assert.equal(current.calls.length, 2);
  }
});

test('catalog reads reject invalid authority and inputs before querying', async () => {
  const client = { query: () => assert.fail('Rejected before database access') }; const sourceId = randomUUID();
  await assert.rejects(loadUserFieldLookupOptions(client, { ...identity, permission_codes: ['masters.read'] }, { sourceId }), { code: 'forbidden' });
  for (const input of [{ sourceId: 'not-an-id' }, { sourceId, revision: 0 }, { sourceId, revision: 2.5 }, { sourceId, revision: '3' },
    { sourceId, revision: 2147483648 }, { sourceId, knownOrganizationId: 'invalid' }, { sourceId, organizationId }]) {
    await assert.rejects(loadUserFieldLookupOptions(client, identity, input), { status: 400 });
  }
});

test('partial, mixed-revision, malformed and oversized catalogs fail instead of appearing complete', async () => {
  const sourceId = randomUUID();
  for (const rows of [[], [line(1, 'text', 'Missing first')], [line(0, 'text', 'Wrong revision', 4)], [line(0, 'text', null)],
    [line(0, 'other', 'Wrong kind')], Array.from({ length: 10001 }, (_, index) => line(index, 'text', 'Too many'))]) {
    await assert.rejects(loadUserFieldLookupOptions(catalogClient(rows), identity, { sourceId }), { code: 'incomplete_user_lookup' });
  }
});
