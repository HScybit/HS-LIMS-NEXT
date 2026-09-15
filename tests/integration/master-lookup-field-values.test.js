import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveProduct, loadProduct, retireProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const originalLines = [{ id: 'A', label: 'Original A' }, { id: 'B', label: 'Original B' }, { id: '0', label: 0 }, { id: 'false', label: false }];
const apis = { product: { save: saveProduct, load: loadProduct, retire: retireProduct, table: 'products' },
  parameter: { save: saveTestParameter, load: loadTestParameter, retire: retireTestParameter, table: 'test_parameters' } };
async function fixture(kind, extra = {}, sourceId = randomUUID()) {
  const api = apis[kind]; const author = await account(); const editor = await account({ organizationId: author.organizationId });
  const source = { id: sourceId, sourceId: 'Original-source-' + randomUUID(), revision: 0, requestId: randomUUID(), name: 'Master lookup', lines: originalLines };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source)); let sourceRevision = 1;
  let definition = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'lookup_key', label: 'Lookup', associatedWith: kind, fieldType: 'lookup', lookupSourceId: sourceId, ...extra };
  let field = await work(author, (c, i) => saveCustomField(c, i, definition));
  const id = randomUUID(); const base = { id, name: 'Captured master lookup', key: randomUUID(), ...(kind === 'parameter' ? { schemeAbbreviation: 'Lookup' } : {}) };
  const command = (value, revision = 0) => ({ ...base, revision, requestId: randomUUID(), customFields: [{ fieldId: field.id, fieldRevision: field.revision, value }] });
  return { kind, api, author, editor, id, base, sourceId, source, field: () => field, command,
    save: input => work(editor, (c, i) => api.save(c, i, input)), read: atRevision => work(editor, (c, i) => api.load(c, i, id, { atRevision }), true),
    observe: async lines => { const result = await work(author, (c, i) => saveLookupSourceObservation(c, i, { ...source, revision: sourceRevision, requestId: randomUUID(), lines })); sourceRevision = result.revision; return result; },
    retireField: () => work(author, (c, i) => retireCustomField(c, i, { id: field.id, revision: field.revision, requestId: randomUUID() })),
    define: async (changes = {}, replace = false) => {
      definition = { ...definition, id: replace ? randomUUID() : field.id, revision: replace ? 0 : field.revision, requestId: randomUUID(), ...changes };
      field = await work(author, (c, i) => saveCustomField(c, i, definition)); return field;
    } };
}
async function rejectWithoutChange(f, action, expected) {
  const before = await owner.query(`SELECT revision FROM ${f.api.table} WHERE organization_id=$1 AND id=$2`, [f.author.organizationId, f.id]);
  await assert.rejects(action(), expected);
  assert.deepEqual((await owner.query(`SELECT revision FROM ${f.api.table} WHERE organization_id=$1 AND id=$2`, [f.author.organizationId, f.id])).rows, before.rows);
}
async function direct(f, input, changes, rejects = true) {
  let inserted = false; let sqlError;
  const action = () => work(f.editor, (c, i) => f.api.save({ async query(sql, args) {
    if (!sql.startsWith(`INSERT INTO ${f.kind}_version_custom_field_values(`)) return c.query(sql, args);
    inserted = true;
    const value = { raw: 'A', state: 'valid', sourceId: f.sourceId, revision: 1, lineId: 'A', parsedBoolean: null, ...changes };
    try {
      return await c.query(`INSERT INTO ${f.kind}_version_custom_field_values
        (organization_id,${f.kind}_id,revision,field_id,position,raw_kind,raw_text,interpretation_state,lookup_source_id,lookup_revision,lookup_line_id,parsed_boolean)
        VALUES($1,$2,$3,$4,0,'text',$5,$6,$7,$8,$9,$10)`,
      [i.organization_id, input.id, input.revision + 1, f.field().id, value.raw, value.state, value.sourceId, value.revision, value.lineId, value.parsedBoolean]);
    } catch (error) { sqlError = { code: error.code, constraint: error.constraint }; throw error; }
  } }, i, input));
  if (rejects) {
    await rejectWithoutChange(f, action, { code: `invalid_${f.kind}_custom_field_reference` });
    assert.equal(sqlError.code, '23514'); assert.equal(sqlError.constraint, `${f.kind}_custom_value_lookup`);
  } else await action();
  assert.equal(inserted, true, 'The test must reach actual SQL after normal preparation.');
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
async function waitForAdvisory(pid) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const row = (await owner.query('SELECT wait_event,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event === 'advisory' && row.blockers > 0) return;
    await delay(20);
  }
  assert.fail('Expected the actual organization definition advisory wait.');
}
for (const kind of ['product', 'parameter']) {
  test(`${kind} configured captures preserve original IDs, raw types, duplicates, frozen labels and exact retries`, async () => {
    const f = await fixture(kind, { allowsMultiple: true }); const raw = ['A', 'A', 0, false, 'B']; const command = f.command(raw);
    const saved = await f.save(command); const capture = saved.customFields[0];
    assert.deepEqual(capture.value, raw); assert.equal(capture.displayValue, 'Original A, Original A, Original B');
    assert.deepEqual(capture.items.map(item => [item.lookupSourceId, item.lookupRevision, item.lookupLineId]), raw.map(value => [f.sourceId, 1, String(value)]));
    const historical = await f.read(1); assert.deepEqual(historical.customFields, saved.customFields);
    await f.observe(originalLines.map(line => ({ ...line, label: 'Changed ' + line.id })));
    assert.deepEqual(await f.save(command), historical); assert.deepEqual((await f.read(1)).customFields, saved.customFields);
    await rejectWithoutChange(f, () => f.save({ ...command, customFields: f.command(['B']).customFields }), { code: 'save_request_reused' });
    const updated = await f.save(f.command(raw, 1)); assert.equal(updated.customFields[0].displayValue, 'Changed A, Changed A, Changed 0, Changed false, Changed B');
    assert(updated.customFields[0].items.every(item => item.lookupRevision === 2));
  });
  test(`${kind} cleared lookups retain only immediate raw values and resolve again when their choices reappear`, async () => {
    const f = await fixture(kind, { allowsMultiple: true }); const raw = ['A', 'A', false]; await f.save(f.command(raw)); await f.observe([]);
    await rejectWithoutChange(f, () => f.save(f.command(['A', 'false'], 1)), { code: `invalid_${kind}_custom_field_lookup` });
    const retained = await f.save(f.command(raw, 1)); assert.deepEqual(retained.customFields[0].value, raw);
    assert(retained.customFields[0].items.every(item => item.interpretationState === 'invalid' && item.lookupSourceId === null && item.lookupRevision === null && item.lookupLineId === null));
    await f.observe(originalLines); const restored = await f.save(f.command(raw, 2)); assert(restored.customFields[0].items.every(item => item.lookupRevision === 3));
    await f.save(f.command([], 3)); await f.observe([]);
    await rejectWithoutChange(f, () => f.save(f.command(raw, 4)), { code: `invalid_${kind}_custom_field_lookup` });
  });
  test(`${kind} lookup retention follows a replacement saved key and rejects a renamed key or another master`, async () => {
    const f = await fixture(kind); await f.save(f.command('A')); await f.observe([]); const originalFieldId = f.field().id;
    await f.retireField(); await f.define({}, true);
    const retained = await f.save(f.command('A', 1)); assert.equal(retained.customFields[0].fieldId, f.field().id);
    assert.equal(retained.customFields[0].items[0].interpretationState, 'invalid'); assert.equal((await f.read(1)).customFields[0].fieldId, originalFieldId);
    await assert.rejects(f.save({ ...f.command('A'), id: randomUUID(), key: randomUUID() }), { code: `invalid_${kind}_custom_field_lookup` });
    await f.define({ key: 'renamed_key' });
    await rejectWithoutChange(f, () => f.save(f.command('A', 2)), { code: `invalid_${kind}_custom_field_lookup` });
  });
  test(`${kind} omission and retirement preserve valid and invalid lookup history after later source changes`, async () => {
    for (const invalid of [false, true]) {
      const f = await fixture(kind); let previous = await f.save(f.command('A')); await f.observe([]);
      if (invalid) { previous = await f.save(f.command('A', 1)); await f.observe(originalLines); }
      await f.retireField(); const command = { ...f.base, revision: previous.revision, requestId: randomUUID() };
      const copied = await f.save(command); assert.equal(copied.customFieldsProvided, false); assert.deepEqual(copied.customFields, previous.customFields);
      const historical = await f.read(copied.revision); assert.deepEqual(await f.save(command), historical);
      await work(f.editor, (c, i) => f.api.retire(c, i, { id: f.id, revision: copied.revision, requestId: randomUUID() }));
      assert.deepEqual((await f.read(copied.revision + 1)).customFields, previous.customFields);
      await assert.rejects(work(f.editor, c => c.query(`UPDATE ${kind}_version_custom_field_values SET lookup_revision=1 WHERE ${kind}_id=$1`, [f.id])), { code: '42501' });
      await assert.rejects(owner.query(`UPDATE ${kind}_version_custom_field_values SET lookup_revision=1 WHERE ${kind}_id=$1`, [f.id]), { code: '55000' });
    }
  });
  test(`${kind} SQL independently rejects forged lookup references and fabricated unavailable values`, async () => {
    const f = await fixture(kind); await f.observe(originalLines);
    for (const changes of [{ sourceId: randomUUID() }, { revision: 1 }, { lineId: 'B' }, { sourceId: null }, { lineId: null }, { parsedBoolean: true },
      { state: 'invalid', sourceId: null, revision: null, lineId: null }]) {
      await direct(f, f.command('A'), { revision: 2, ...changes });
    }
    await f.save(f.command('A')); await f.observe([]); const invalid = { state: 'invalid', sourceId: null, revision: null, lineId: null };
    await direct(f, f.command('A', 1), { ...invalid, raw: 'Unknown' });
    await direct(f, f.command('A', 1), invalid, false);
    assert.equal((await f.read()).customFields[0].items[0].interpretationState, 'invalid');
  });
  test(`${kind} lookup reads and writes retain actual tenant and permission boundaries`, async () => {
    const f = await fixture(kind); const other = await fixture(kind, {}, f.sourceId); await other.observe([{ id: 'A', label: 'Other tenant A' }]);
    const saved = await f.save(f.command('A')); const foreign = await other.save(other.command('A'));
    assert.equal(saved.customFields[0].displayValue, 'Original A'); assert.equal(foreign.customFields[0].displayValue, 'Other tenant A');
    await assert.rejects(work(other.editor, (c, i) => f.api.load(c, i, f.id), true), { code: kind === 'product' ? 'product_not_found' : 'parameter_not_found' });
    const reader = await account({ organizationId: f.author.organizationId, permissions: ['masters.read'] });
    assert.equal((await work(reader, (c, i) => f.api.load(c, i, f.id), true)).customFields[0].displayValue, 'Original A');
    await assert.rejects(work(reader, (c, i) => f.api.save(c, i, f.command('A', 1))), { code: 'forbidden' });
    assert.equal((await getPool().query('SELECT 1 FROM custom_field_lookup_lines')).rowCount, 0);
    await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [f.editor.userId]);
    await assert.rejects(f.save(f.command('A', 1)), { status: 401 });
  });
  test(`${kind} source observations and captures serialize in either order with the actual captured revision`, async () => {
    for (const first of ['source', 'capture']) {
      const f = await fixture(kind); const command = f.command('A'); const changed = { ...f.source, revision: 1, requestId: randomUUID(), lines: [{ id: 'A', label: 'Changed A' }] };
      const actions = first === 'source' ? [(c, i) => saveLookupSourceObservation(c, i, changed), (c, i) => f.api.save(c, i, command)]
        : [(c, i) => f.api.save(c, i, command), (c, i) => saveLookupSourceObservation(c, i, changed)];
      const actors = first === 'source' ? [f.author, f.editor] : [f.editor, f.author];
      const held = deferred(); const ready = deferred(); const release = deferred(); let leader; let follower; let led; let followed;
      try {
        leader = settle(work(actors[0], async (c, i) => { const result = await actions[0](c, i); held.resolve(); await release.promise; return result; }));
        assert.equal(await Promise.race([held.promise.then(() => 'held'), leader.then(() => 'ended')]), 'held');
        follower = settle(work(actors[1], async (c, i) => { ready.resolve((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return actions[1](c, i); }));
        const pid = await Promise.race([ready.promise, follower.then(() => null)]); assert.notEqual(pid, null); await waitForAdvisory(pid);
      } finally { release.resolve(); if (leader) led = await leader; if (follower) followed = await follower; }
      assert.equal(led.error, undefined); assert.equal(followed.error, undefined);
      const saved = (await f.read()).customFields[0]; assert.equal(saved.displayValue, first === 'source' ? 'Changed A' : 'Original A');
      assert.equal(saved.items[0].lookupRevision, first === 'source' ? 2 : 1);
    }
  });
  test(`${kind} mixed lookup captures enforce unique fields and preserve unrestricted repeated choices`, async () => {
    const f = await fixture(kind, { allowsMultiple: true, validateUniqueness: true });
    const extra = await work(f.author, (c, i) => saveCustomField(c, i, { id: randomUUID(), revision: 0, requestId: randomUUID(),
      associatedWith: kind, key: 'unrestricted', label: 'Unrestricted', fieldType: 'lookup', lookupSourceId: f.sourceId, allowsMultiple: true }));
    const command = (value, id = f.id, revision = 0) => {
      const input = f.command(value, revision);
      return { ...input, id, key: id, ...(kind === 'parameter' ? { schemeAbbreviation: id } : {}),
        customFields: [...input.customFields, { fieldId: extra.id, fieldRevision: extra.revision, value: ['A', 'A'] }] };
    };
    const duplicate = { code: `duplicate_${kind}_custom_field` };
    await rejectWithoutChange(f, () => f.save(command(['A', 'A'])), duplicate);
    const first = await f.save(command(['A']));
    assert.deepEqual(first.customFields.find(field => field.key === 'unrestricted').value, ['A', 'A']);
    const secondId = randomUUID();
    await assert.rejects(f.save(command(['A'], secondId)), duplicate);
    assert.equal((await owner.query(`SELECT 1 FROM ${f.api.table} WHERE organization_id=$1 AND id=$2`, [f.author.organizationId, secondId])).rowCount, 0);
    await f.save(command(['B'], secondId));
    await rejectWithoutChange(f, () => f.save(command(['B'], f.id, 1)), duplicate);
    assert.deepEqual((await f.read()).customFields.find(field => field.key === 'lookup_key').value, ['A']);
  });
  for (const operation of ['api', 'retry', 'retire', 'sql']) test(`${kind} ${operation} lookup changes reject permission or session loss during a definition wait`, async () => {
    for (const loss of ['permission', 'session']) {
      const f = await fixture(kind); const initial = f.command('A'); await f.save(initial);
      const update = (c, i) => c.query(`UPDATE ${f.api.table} SET name='Queued lookup copy',revision=revision+1,
        save_request_id=$3,custom_fields_provided=false,updated_at=transaction_timestamp()
        WHERE organization_id=$1 AND id=$2`, [i.organization_id, f.id, randomUUID()]);
      if (operation === 'sql') { await f.retireField(); await work(f.editor, update); }
      const beforeRevision = operation === 'sql' ? 2 : 1;
      const holder = await owner.connect(); const ready = deferred(); let pending; let result;
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [f.author.organizationId]);
        pending = settle(work(f.editor, async (c, i) => {
          ready.resolve((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          if (operation === 'api') return f.api.save(c, i, f.command('B', 1));
          if (operation === 'retry') return f.api.save(c, i, initial);
          if (operation === 'retire') return f.api.retire(c, i, { id: f.id, revision: 1, requestId: randomUUID() });
          return update(c, i);
        }));
        const pid = await Promise.race([ready.promise, pending.then(() => null)]); assert.notEqual(pid, null); await waitForAdvisory(pid);
        if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.editor.organizationId, f.editor.roleId]);
        else await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [f.editor.userId]);
      } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) result = await pending; }
      assert(result.error, `${kind} ${operation} accepted the write after queued ${loss} loss.`);
      if (operation === 'sql') { assert.equal(result.error.code, '42501'); assert.equal(result.error.constraint, 'master_field_session_required'); }
      else { assert.equal(result.error.status, 403); assert.equal(result.error.code, 'forbidden'); }
      assert.equal((await owner.query(`SELECT revision FROM ${f.api.table} WHERE organization_id=$1 AND id=$2`, [f.author.organizationId, f.id])).rows[0].revision, beforeRevision);
      assert.equal((await owner.query(`SELECT count(*)::integer AS count FROM ${kind === 'product' ? 'product_versions' : 'test_parameter_versions'} WHERE organization_id=$1 AND ${kind}_id=$2`, [f.author.organizationId, f.id])).rows[0].count, beforeRevision);
    }
  });
}
