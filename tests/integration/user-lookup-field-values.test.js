import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { createUser } from '../../src/users/create.js';
import { updateUserForm, loadUserForm } from '../../src/users/forms.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; }
async function fixture(changes = {}, lines = [{ id: 'A', label: 'Original A' }, { id: 'B', label: 'Original B' }]) {
  const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  let sourceInput = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-' + randomUUID(), name: 'Lookup source', lines };
  let source = await work(author, (c, i) => saveLookupSourceObservation(c, i, sourceInput));
  const observe = async lines => {
    sourceInput = { ...sourceInput, requestId: randomUUID(), revision: source.revision, lines };
    source = await work(author, (c, i) => saveLookupSourceObservation(c, i, sourceInput)); return source;
  };
  let definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'saved_lookup', label: 'Lookup', associatedWith: 'users',
    fieldType: 'lookup', lookupSourceId: source.id, ...changes };
  let field = await work(author, (c, i) => saveCustomField(c, i, definition));
  const define = async changes => {
    definition = { ...definition, requestId: randomUUID(), revision: field.revision, ...changes };
    field = await work(author, (c, i) => saveCustomField(c, i, definition)); return field;
  };
  const replace = async changes => {
    const key = field.key; await define({ key: 'old_' + randomUUID().replaceAll('-', '') });
    await work(author, (c, i) => retireCustomField(c, i, { id: field.id, requestId: randomUUID(), revision: field.revision }));
    return define({ id: randomUUID(), revision: 0, key, ...changes });
  };
  const input = (value, revision = 0, requestId = randomUUID()) => ({ revision, requestId, customFields: [{ fieldId: field.id, fieldRevision: field.revision, value }] });
  return { author, manager, person, define, replace, observe, field: () => field, source: () => source, sourceInput: () => sourceInput, input,
    save: (value, revision, requestId, subject = person) => work(manager, (c, i) => saveUserCustomFields(c, i, subject.userId, input(value, revision, requestId))),
    read: (options, subject = person) => work(manager, (c, i) => loadUserCustomFields(c, i, subject.userId, options), true) };
}
async function unchanged(f, action, error) {
  const before = await f.read();
  const count = async () => (await owner.query('SELECT count(*)::integer AS count FROM user_field_value_versions WHERE organization_id=$1 AND subject_user_id=$2', [f.author.organizationId, f.person.userId])).rows[0].count;
  const beforeCount = await count(); await assert.rejects(action, error); assert.deepEqual(await f.read(), before); assert.equal(await count(), beforeCount);
}

test('configured captures pin actual line observations and preserve old labels and exact retries after source changes', async () => {
  const f = await fixture(); const request = f.input('A'); const first = await work(f.manager, (c, i) => saveUserCustomFields(c, i, f.person.userId, request));
  const original = await f.read(); assert.equal(original.customFields[0].displayValue, 'Original A');
  assert.equal(original.customFields[0].items[0].lookupSourceId, f.source().id);
  assert.equal(original.customFields[0].items[0].lookupRevision, 1); assert.equal(original.customFields[0].items[0].lookupLineId, 'A');
  await f.observe([{ id: 'A', label: 'Current A' }]); await f.save('A', 1);
  const current = await f.read(); assert.equal(current.customFields[0].displayValue, 'Current A'); assert.equal(current.customFields[0].items[0].lookupRevision, 2);
  assert.deepEqual(await f.read({ atRevision: 1 }), original);
  assert.deepEqual(await work(f.manager, (c, i) => saveUserCustomFields(c, i, f.person.userId, request)), first);
  assert.deepEqual(await f.read(), current);
  await unchanged(f, () => work(f.manager, (c, i) => saveUserCustomFields(c, i, f.person.userId, { ...request, customFields: [{ ...request.customFields[0], value: 'B' }] })), { code: 'save_request_reused' });
});

test('lookup arrays preserve primitive types, order, duplicates and source-compatible false and zero displays', async () => {
  const f = await fixture({ allowsMultiple: true }, [{ id: '0', label: 0 }, { id: 'false', label: false }, { id: 'A', label: 'Alpha' }, { id: '1e+21', label: 'Large' }]);
  await f.save([false, 'A', 0, 'A', 'false', '0', 1e21], 0);
  let field = (await f.read()).customFields[0]; assert.deepEqual(field.value, [false, 'A', 0, 'A', 'false', '0', 1e21]);
  assert.equal(field.displayValue, 'Alpha, Alpha, Large'); assert.deepEqual(field.items.map(item => item.lookupLineId), ['false', 'A', '0', 'A', 'false', '0', '1e+21']);
  await f.define({ allowsMultiple: false }); await f.save(0, 1); field = (await f.read()).customFields[0]; assert.equal(field.displayValue, 0); assert.equal(field.value, 0);
  await f.save(false, 2); assert.equal((await f.read()).customFields[0].displayValue, false);
  await f.save('', 3); assert.equal((await f.read()).customFields[0].items[0].lookupSourceId, null);
});

test('unavailable values require the immediate same-subject saved key and regain actual references on reappearance', async () => {
  const f = await fixture(); const originalId = f.field().id; await f.save('A', 0); await f.observe([]); await f.replace();
  await f.save('A', 1); let field = (await f.read()).customFields[0]; assert.notEqual(field.fieldId, originalId); assert.equal(field.key, 'saved_lookup');
  assert.equal(field.displayValue, 'A'); assert.equal(field.items[0].interpretationState, 'invalid'); assert.equal(field.items[0].lookupSourceId, null);
  await f.save('A', 2); await f.observe([{ id: 'A', label: 'Reappeared A' }]); await f.save('A', 3);
  field = (await f.read()).customFields[0]; assert.equal(field.displayValue, 'Reappeared A'); assert.equal(field.items[0].lookupRevision, 3);
  assert.equal((await f.read({ atRevision: 2 })).customFields[0].items[0].lookupRevision, null);
  await f.observe([]); await f.define({ lookupSourceId: null }); await f.save('A', 4);
  await f.define({ key: 'different_key' }); await unchanged(f, () => f.save('A', 5), { code: 'invalid_user_custom_field_lookup' });
  await f.define({ key: 'saved_lookup' }); await f.save('', 5);
  await unchanged(f, () => f.save('A', 6), { code: 'invalid_user_custom_field_lookup' });
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await assert.rejects(f.save('A', 0, undefined, other), { code: 'invalid_user_custom_field_lookup' });
});

test('raw primitive retention never borrows a String-equivalent prior value and mandatory empty values still reject', async () => {
  const f = await fixture({ fieldType: 'text', allowsMultiple: true, lookupSourceId: null }); await f.save([0, false, 'A'], 0);
  await f.define({ fieldType: 'lookup' }); await f.save([false, 0, 'A', 'A'], 1);
  await unchanged(f, () => f.save(['false', 0, 'A'], 2), { code: 'invalid_user_custom_field_lookup' });
  await unchanged(f, () => f.save([false, '0', 'A'], 2), { code: 'invalid_user_custom_field_lookup' });
  await f.save([], 2); await f.define({ isRequired: true });
  await unchanged(f, () => f.save([], 3), { code: 'invalid_custom_field_value' });
});

test('the current user lookup view exposes only active bound user sources in the actual tenant', async () => {
  const f = await fixture(); const foreign = await fixture();
  const query = actor => work(actor, c => c.query('SELECT organization_id,source_id,revision,original_line_id FROM user_custom_field_lookup_lines ORDER BY original_line_id'), true);
  assert.equal((await query(f.manager)).rowCount, 2); assert((await query(f.manager)).rows.every(row => row.organization_id === f.author.organizationId && row.source_id === f.source().id));
  assert.equal((await query(f.author)).rowCount, 0); assert((await query(foreign.manager)).rows.every(row => row.source_id === foreign.source().id));
  assert.equal((await getPool().query('SELECT * FROM user_custom_field_lookup_lines')).rowCount, 0);
  await f.observe([{ id: 'B', label: 'Only current B' }]); assert.deepEqual((await query(f.manager)).rows.map(row => [row.original_line_id, row.revision]), [['B', 2]]);
  await f.define({ fieldType: 'text' }); assert.equal((await query(f.manager)).rowCount, 0);
  await f.define({ fieldType: 'lookup' }); await work(f.author, (c, i) => retireCustomField(c, i, { id: f.field().id, requestId: randomUUID(), revision: f.field().revision }));
  assert.equal((await query(f.manager)).rowCount, 0);
  const privileges = (await owner.query(`SELECT has_table_privilege('sampleify_report_worker','user_custom_field_lookup_lines','SELECT') AS worker_view,
    has_function_privilege('sampleify_report_worker','masters_lock_lookup_observer()','EXECUTE') AS worker_helper`)).rows[0];
  assert.deepEqual(privileges, { worker_view: false, worker_helper: false });
});

async function direct(f, { value = 'A', state = 'valid', revision = 0, sourceId = f.source().id, lookupRevision = f.source().revision,
  lineId = String(value), parsedNumber = null, subject = f.person } = {}) {
  return work(f.manager, async (c, i) => {
    const field = f.field(); await c.query('SELECT * FROM users_begin_field_capture($1,$2,$3,1,NULL)', [subject.userId, revision, randomUUID()]);
    await c.query(`INSERT INTO user_version_custom_fields(organization_id,subject_user_id,revision,field_id,field_revision,field_type,position,is_array,value_count,display_kind,display_text)
      VALUES($1,$2,$3,$4,$5,$6,0,false,1,'text',$7)`, [i.organization_id, subject.userId, revision + 1, field.id, field.revision, field.fieldType, String(value)]);
    await c.query(`INSERT INTO user_version_custom_field_values(organization_id,subject_user_id,revision,field_id,position,raw_kind,raw_text,raw_number,raw_boolean,raw_number_text,
      interpretation_state,lookup_source_id,lookup_revision,lookup_line_id,parsed_number)
      VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [i.organization_id, subject.userId, revision + 1, field.id,
      typeof value === 'string' ? 'text' : typeof value, typeof value === 'string' ? value : null, typeof value === 'number' ? value : null,
      typeof value === 'boolean' ? value : null, typeof value === 'number' ? String(value) : null, state, sourceId, lookupRevision, lineId, parsedNumber]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
}

test('SQL rejects foreign, unrelated, old, partial, mismatched and mixed lookup references independently of preparation', async () => {
  const f = await fixture(); const foreign = await fixture();
  const unrelated = await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    sourceId: randomUUID(), name: 'Unbound source', lines: [{ id: 'A', label: 'Other A' }] }));
  await f.observe([{ id: 'A', label: 'Current A' }]);
  for (const changes of [{ sourceId: foreign.source().id }, { sourceId: unrelated.id }, { lookupRevision: 1 }, { sourceId: null }, { lookupRevision: null },
    { lineId: null }, { lineId: 'B' }, { parsedNumber: 1 }, { value: 'unknown' }, { state: 'invalid', sourceId: null, lookupRevision: null, lineId: null }]) {
    await unchanged(f, () => direct(f, changes), { code: '23514', constraint: 'user_custom_value_lookup' });
  }
  await direct(f); assert.equal((await f.read()).customFields[0].items[0].lookupRevision, 2);
  await assert.rejects(work(f.manager, c => c.query('UPDATE user_version_custom_field_values SET lookup_revision=1 WHERE subject_user_id=$1', [f.person.userId])), { code: '42501' });
  await f.define({ fieldType: 'text' }); await unchanged(f, () => direct(f, { revision: 1 }), { code: '23514' });
});

test('SQL retained lookup guards require the immediate same-key raw value without fabricated provenance', async () => {
  const f = await fixture(); await f.save('A', 0); await f.observe([]); await f.replace();
  const retained = { state: 'invalid', sourceId: null, lookupRevision: null, lineId: null, revision: 1 };
  await unchanged(f, () => direct(f, { ...retained, value: 'unknown' }), { code: '23514', constraint: 'user_custom_value_lookup' });
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await assert.rejects(direct(f, { ...retained, revision: 0, subject: other }), { code: '23514', constraint: 'user_custom_value_lookup' });
  await direct(f, retained); assert.equal((await f.read()).customFields[0].items[0].interpretationState, 'invalid');
  await f.define({ key: 'different_key' });
  await unchanged(f, () => direct(f, { ...retained, revision: 2 }), { code: '23514', constraint: 'user_custom_value_lookup' });
});

test('configured lookups participate in atomic creation, complete-form rollback, uniqueness and exact retries', async () => {
  const f = await fixture({ validateUniqueness: true }); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Lookup lab')", [f.author.organizationId, lab]);
  const id = randomUUID(); const fields = f.input('A').customFields;
  const input = { id, requestId: randomUUID(), revision: 0, username: 'lookup-' + id, email: id + '@example.invalid', displayName: 'Lookup user',
    password: 'Synthetic-Password-For-Tests!', defaultRoleId: f.person.roleId, laboratoryId: lab, customFields: fields };
  await assert.rejects(work(f.manager, (c, i) => createUser(c, i, { ...input, customFields: f.input('missing').customFields })), { code: 'invalid_user_custom_field_lookup' });
  assert.equal((await owner.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount, 0);
  const created = await work(f.manager, (c, i) => createUser(c, i, input)); assert.equal(created.customFieldRevision, 1);
  assert.deepEqual(await work(f.manager, (c, i) => createUser(c, i, input)), created);
  const form = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: f.person.username, email: f.person.email,
    displayName: 'Atomic lookup edit', phone: 'Atomic contact', defaultRoleId: f.person.roleId, laboratoryId: lab, customFieldRevision: 0, customFields: fields };
  const read = () => work(f.manager, (c, i) => loadUserForm(c, i, f.person.userId), true); const before = await read();
  await assert.rejects(work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, form)), { code: 'duplicate_user_custom_field' }); assert.deepEqual(await read(), before);
  const valid = { ...form, customFields: f.input('B').customFields };
  const saved = await work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, valid)); assert.equal(saved.customFieldRevision, 1);
  await f.observe([{ id: 'B', label: 'Later B' }]);
  assert.deepEqual(await work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, valid)), saved);
  assert.equal((await read()).fieldCapture.customFields[0].displayValue, 'Original B'); assert.equal((await read()).profile.phone, form.phone);
});

test('the batched current-choice read scopes matching line IDs to each field source', async () => {
  const f = await fixture();
  const other = await work(f.author, (c, i) => saveLookupSourceObservation(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    sourceId: randomUUID(), name: 'Other source', lines: [{ id: 'A', label: 'Other A' }] }));
  const second = await work(f.author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'other_lookup',
    label: 'Other lookup', associatedWith: 'users', fieldType: 'lookup', lookupSourceId: other.id }));
  let lookups = 0;
  await work(f.manager, (client, identity) => saveUserCustomFields({ query(sql, args) {
    if (sql.includes('JOIN user_custom_field_lookup_lines')) { lookups++; assert.deepEqual(args[1], [f.source().id, other.id]); }
    return client.query(sql, args);
  } }, identity, f.person.userId, { requestId: randomUUID(), revision: 0, customFields: [f.input('A').customFields[0], { fieldId: second.id, fieldRevision: 1, value: 'A' }] }));
  assert.equal(lookups, 1); const fields = (await f.read()).customFields;
  assert.deepEqual(fields.map(field => field.displayValue), ['Original A', 'Other A']);
  assert.deepEqual(fields.map(field => field.items[0].lookupSourceId), [f.source().id, other.id]);
});

function signal() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const awaitReady = (notice, pending) => Promise.race([notice.promise, pending.then(result => { throw result.error ?? new Error('Operation ended before its synchronization point.'); })]);
async function waitForAdvisory(pid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await owner.query('SELECT wait_event,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event === 'advisory' && row.blockers > 0) return;
    await delay(10);
  }
  throw new Error('Expected an actual blocked advisory lock.');
}

test('source updates and captures serialize in either order without replacing captured labels', async () => {
  for (const first of ['source', 'capture']) {
    const f = await fixture(); await f.save('A', 0);
    const update = (c, i) => saveLookupSourceObservation(c, i, { ...f.sourceInput(), requestId: randomUUID(), revision: 1, lines: [{ id: 'A', label: 'Changed A' }] });
    const capture = (c, i) => saveUserCustomFields(c, i, f.person.userId, f.input('A', 1));
    const actions = first === 'source' ? [update, capture] : [capture, update];
    const actors = first === 'source' ? [f.author, f.manager] : [f.manager, f.author];
    const held = signal(); const ready = signal(); const release = signal(); let leader; let follower; let led; let followed;
    try {
      leader = settle(work(actors[0], async (c, i) => { const result = await actions[0](c, i); held.resolve(); await release.promise; return result; }));
      await awaitReady(held, leader);
      follower = settle(work(actors[1], async (c, i) => { ready.resolve((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return actions[1](c, i); }));
      await waitForAdvisory(await awaitReady(ready, follower));
      const probe = await owner.connect();
      try { await probe.query('BEGIN'); await probe.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE NOWAIT', [actors[1].userId]); }
      finally { await probe.query('ROLLBACK'); probe.release(); }
    } finally { release.resolve(); if (leader) led = await leader; if (follower) followed = await follower; }
    assert.equal(led.error, undefined); assert.equal(followed.error, undefined);
    const field = (await f.read()).customFields[0]; assert.equal(field.displayValue, first === 'source' ? 'Changed A' : 'Original A');
    assert.equal(field.items[0].lookupRevision, first === 'source' ? 2 : 1);
    assert.equal((await f.read({ atRevision: 1 })).customFields[0].displayValue, 'Original A');
  }
});

test('permission and session loss during lookup advisory waits reject source saves, retries, direct SQL and captures', async () => {
  for (const operation of ['source', 'retry', 'sql', 'capture']) for (const loss of ['permission', 'session']) {
    const f = await fixture(); const actor = operation === 'capture' ? f.manager : f.author;
    const holder = await owner.connect(); const ready = signal(); let pending; let result;
    try {
      await holder.query('BEGIN'); await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [f.author.organizationId]);
      pending = settle(work(actor, async (c, i) => {
        ready.resolve((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if (operation === 'capture') return saveUserCustomFields(c, i, f.person.userId, f.input('A'));
        if (operation === 'sql') return c.query(`UPDATE custom_field_lookup_sources SET name='Blocked source',line_count=0,request_id=$3,
          revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, [i.organization_id, f.source().id, randomUUID()]);
        return saveLookupSourceObservation(c, i, operation === 'retry' ? f.sourceInput() : { ...f.sourceInput(), requestId: randomUUID(), revision: 1 });
      }));
      await waitForAdvisory(await awaitReady(ready, pending));
      if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [actor.organizationId, actor.roleId]);
      else await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [actor.userId]);
    } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) result = await pending; }
    assert.equal(result.error?.code, operation === 'sql' ? '42501' : 'forbidden', `${operation}/${loss}`);
    assert.equal((await owner.query('SELECT revision FROM custom_field_lookup_sources WHERE organization_id=$1 AND id=$2', [f.author.organizationId, f.source().id])).rows[0].revision, 1);
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM custom_field_lookup_versions WHERE organization_id=$1', [f.author.organizationId])).rows[0].count, 1);
    assert.equal((await owner.query('SELECT custom_field_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, f.person.userId])).rows[0].custom_field_revision, 0);
  }
});
