import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadMasterFieldLookupOptions } from '../../src/custom-fields/lookup-sources.js';
import { masterFieldLookupQuery } from '../../src/masters/custom-field-lookup-query.js';
import { loadMasterFieldLookupSources } from '../../src/masters/custom-field-lookup-client.js';

const sourceId = randomUUID(); const organizationId = randomUUID();
const identity = { organization_id: organizationId, permission_codes: ['masters.read'] };
const header = (count = 3) => ({ revision: 4, headLineCount: count, lineCount: count });
const rows = [{ value: 'original-A', position: 0, kind: 'text', text: 'First label' },
  { value: '0', position: 1, kind: 'number', number: 0 }, { value: 'false', position: 2, kind: 'boolean', boolean: false }];
function client(...results) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); assert(results.length, 'Unexpected catalog query'); return { rows: results.shift() }; } };
}
for (const kind of ['product', 'parameter']) {
  test(`${kind} catalogs preserve complete ordered primitive labels and scope the configured-source probe`, async () => {
    const c = client([header()], rows); const result = await loadMasterFieldLookupOptions(kind, c, identity, { sourceId: sourceId.toUpperCase() });
    assert.deepEqual(result, { organizationId, sourceId, revision: 4, options: [{ value: 'original-A', label: 'First label' }, { value: '0', label: 0 }, { value: 'false', label: false }] });
    assert.deepEqual(c.calls[0].args, [organizationId, sourceId, kind]); assert.deepEqual(c.calls[1].args, [organizationId, sourceId, 4, 10001]);
  });
  test(`${kind} unavailable catalogs and known empty observations retain distinct cache behavior`, async () => {
    const unavailable = client([]);
    assert.deepEqual(await loadMasterFieldLookupOptions(kind, unavailable, identity, { sourceId }), { organizationId, sourceId, revision: null, options: [] });
    const empty = client([header(0)], []);
    assert.deepEqual(await loadMasterFieldLookupOptions(kind, empty, identity, { sourceId }), { organizationId, sourceId, revision: 4, options: [] });
    const unchanged = client([header(0)]);
    assert.deepEqual(await loadMasterFieldLookupOptions(kind, unchanged, identity, { sourceId, revision: 4, knownOrganizationId: organizationId }), { organizationId, sourceId, revision: 4, unchanged: true });
    const otherOrganization = client([header()], rows);
    assert.equal((await loadMasterFieldLookupOptions(kind, otherOrganization, identity, { sourceId, revision: 4, knownOrganizationId: randomUUID() })).options.length, 3);
  });
  test(`${kind} incomplete catalogs and invalid requests cannot publish choices`, async () => {
    for (const value of [{ ...header(), lineCount: null }, { ...header(), headLineCount: 2 }, header(10001)]) {
      await assert.rejects(loadMasterFieldLookupOptions(kind, client([value]), identity, { sourceId, revision: 4, knownOrganizationId: organizationId }), { code: 'incomplete_master_lookup' });
    }
    for (const values of [rows.slice(0, 2), [rows[0], rows[0], rows[2]], [rows[0], rows[1], { ...rows[2], boolean: null }], [rows[0], rows[1], { ...rows[2], kind: 'unknown' }]]) {
      await assert.rejects(loadMasterFieldLookupOptions(kind, client([header()], values), identity, { sourceId }), { code: 'incomplete_master_lookup' });
    }
    for (const input of [{ sourceId: 'invalid' }, { sourceId, revision: 0 }, { sourceId, revision: 2147483648 }, { sourceId, knownOrganizationId: '' }, { sourceId, extra: true }]) {
      await assert.rejects(loadMasterFieldLookupOptions(kind, client(), identity, input), { status: 400 });
    }
    await assert.rejects(loadMasterFieldLookupOptions(kind, client(), { ...identity, permission_codes: ['users.manage'] }, { sourceId }), { status: 403 });
  });
  test(`${kind} client uses its fixed master route and shares a catalog model between fields`, async () => {
    const fields = [{ fieldType: 'lookup', lookupSourceId: sourceId }, { fieldType: 'lookup', lookupSourceId: sourceId }];
    const calls = []; const options = [{ value: 'A', label: 0 }, { value: 'B', label: false }];
    const first = await loadMasterFieldLookupSources(kind, fields, undefined, { request: async url => {
      calls.push(url); return { organizationId, sourceId, revision: 4, options };
    } });
    assert.equal(calls.length, 1); assert.equal(new URL(calls[0], 'http://local').pathname, `/api/masters/${kind === 'product' ? 'products' : 'test-parameters'}/custom-fields/lookup-options`);
    assert.equal(first.get(sourceId).options, options); assert.equal(first.get(sourceId).selectOptions.sourceOptions, options);
    const next = await loadMasterFieldLookupSources(kind, fields, first, { request: async url => {
      const query = new URL(url, 'http://local').searchParams; assert.equal(query.get('revision'), '4'); assert.equal(query.get('knownOrganizationId'), organizationId);
      return { organizationId, sourceId, revision: 4, unchanged: true };
    } });
    assert.equal(next.get(sourceId), first.get(sourceId));
    await assert.rejects(loadMasterFieldLookupSources(kind, fields, first, { organizationId, request: async () =>
      ({ organizationId: randomUUID(), sourceId, revision: 4, options }) }), /Lookup choices changed/);
  });
}
test('master lookup queries reject ambiguous keys and noncanonical revision syntax', () => {
  assert.deepEqual(masterFieldLookupQuery(new URLSearchParams({ sourceId, revision: '4', knownOrganizationId: organizationId })), { sourceId, revision: 4, knownOrganizationId: organizationId });
  for (const query of ['', 'sourceId=a&sourceId=b', 'sourceId=a&extra=b', 'sourceId=a&revision=1&revision=2', 'sourceId=a&knownOrganizationId=a&knownOrganizationId=b',
    ...['', '0', '-1', '01', '1.0', '2e0', '10000000000'].map(revision => `sourceId=a&revision=${revision}`)]) {
    assert.throws(() => masterFieldLookupQuery(new URLSearchParams(query)), { code: 'invalid_master_field_query' });
  }
  assert.throws(() => loadMasterFieldLookupSources('users', []), TypeError);
});
