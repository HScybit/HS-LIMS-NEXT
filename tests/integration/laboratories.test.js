import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadLaboratory, saveLaboratory, retireLaboratory, listLaboratories } from '../../src/masters/laboratories.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action) => withSession(actor.token, action, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['users.manage', 'masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const command = (changes = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), code: 'LAB-' + randomUUID(), name: 'Original Lab',
  description: null, abbreviation: 'LAB', businessUnitId: null, headUserId: null, delegateUserId: null,
  minimumTemperature: '20', maximumTemperature: '30', minimumHumidity: '30', maximumHumidity: '60', active: true, ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveLaboratory(client, identity, input));
const load = (actor, id, atRevision) => work(actor, (client, identity) => loadLaboratory(client, identity, id, atRevision === undefined ? {} : { atRevision }));
const retire = (actor, input) => work(actor, (client, identity) => retireLaboratory(client, identity, input));
const list = (actor, input) => work(actor, (client, identity) => listLaboratories(client, identity, input));

test('Lab authoring captures typed references, raw limits and immutable labels through edits, retirement and reactivation', async () => {
  const actor = await account(); const person = await account({ organizationId: actor.organizationId, permissions: [] }); const unit = randomUUID();
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Original unit')", [actor.organizationId, unit]);
  const input = command({ businessUnitId: unit, headUserId: person.userId, delegateUserId: person.userId, minimumTemperature: '0', maximumTemperature: '30C', minimumHumidity: ' ', maximumHumidity: 'Infinity' });
  const original = await save(actor, input); assert.equal(original.revision, 1); assert.equal(original.operation, 'create'); assert.equal(original.savedBy, actor.userId);
  assert.equal(original.businessUnitName, 'Original unit'); assert.equal(original.headUserName, 'Synthetic Analyst'); assert.equal(original.delegateUserName, 'Synthetic Analyst');
  assert.equal(original.minimumHumidity, ' '); assert.equal(original.maximumHumidity, 'Infinity');
  await owner.query("UPDATE users SET display_name='Current person',active=false WHERE id=$1", [person.userId]);
  await owner.query("UPDATE business_units SET name='Current unit',active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, unit]);
  const current = await load(actor, input.id); assert.equal(current.headUserName, 'Current person'); assert.equal(current.businessUnitName, 'Current unit');
  assert.deepEqual(await load(actor, input.id, 1), original); assert.deepEqual(await save(actor, input), original);
  const second = await save(actor, { ...input, revision: 1, requestId: randomUUID(), description: '' });
  assert.equal(second.headUserName, 'Current person'); assert.equal(second.businessUnitName, 'Current unit'); assert.equal(second.description, '');
  const removal = { id: input.id, revision: 2, requestId: randomUUID() }; const removed = await retire(actor, removal);
  assert.equal(removed.operation, 'retire'); assert.equal(removed.active, false);
  await save(actor, { ...input, revision: 3, requestId: randomUUID(), active: true }); assert.deepEqual(await retire(actor, removal), removed);
  assert.deepEqual(await load(actor, input.id, 1), original); assert.equal((await load(actor, input.id)).active, true);
});

test('legacy Lab first edits preserve long unchanged values and unknown limits without fabricating missing revisions', async () => {
  const actor = await account(); const id = randomUUID(); const name = '  ' + 'L'.repeat(250) + '  '; const code = 'old Lab code';
  await owner.query('INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,$3,$4)', [actor.organizationId, id, code, name]);
  const original = await load(actor, id); assert.equal(original.minimumTemperature, null);
  const input = command({ id, revision: 1, code, name, minimumTemperature: null, maximumTemperature: null, minimumHumidity: null, maximumHumidity: null });
  await save(actor, input); assert.equal((await load(actor, id, 2)).name, name); assert.equal((await load(actor, id, 2)).minimumHumidity, null);
  await assert.rejects(load(actor, id, 1), { status: 404 });
  await assert.rejects(save(actor, { ...input, revision: 2, requestId: randomUUID(), name: 'N'.repeat(201) }), { status: 400 });
  const removed = await retire(actor, { id, revision: 2, requestId: randomUUID() }); assert.equal(removed.name, name); assert.equal(removed.code, code);
});

test('new or changed Lab values enforce bounds and tenant references while inactive people remain metadata choices', async () => {
  const actor = await account(); const other = await account(); const inactive = await account({ organizationId: actor.organizationId, permissions: [] }); const unit = randomUUID();
  await owner.query('UPDATE users SET active=false WHERE id=$1', [inactive.userId]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name,active) VALUES($1,$2::uuid,$2::text,'Inactive unit',false)", [actor.organizationId, unit]);
  assert.equal((await save(actor, command({ headUserId: inactive.userId }))).headUserId, inactive.userId);
  for (const changes of [{ code: 'bad code' }, { name: 'N'.repeat(201) }, { abbreviation: 'A'.repeat(21) }, { description: 'D'.repeat(2001) },
    { minimumTemperature: null }, { minimumHumidity: '' }, { maximumHumidity: '1'.repeat(2001) }]) await assert.rejects(save(actor, command(changes)), { status: 400 });
  for (const changes of [{ headUserId: other.userId }, { delegateUserId: randomUUID() }]) await assert.rejects(save(actor, command(changes)), { status: 422, code: 'invalid_laboratory_user' });
  await assert.rejects(save(actor, command({ businessUnitId: unit })), { status: 422, code: 'invalid_business_unit' });
  const input = command({ name: 'N'.repeat(200), code: 'C'.repeat(64), abbreviation: 'A'.repeat(20), description: 'D'.repeat(2000), minimumTemperature: '1'.repeat(2000) });
  await save(actor, input); await assert.rejects(save(actor, command({ code: input.code.toLowerCase() })), { status: 409, code: 'laboratory_code_exists' });
  await retire(actor, { id: input.id, revision: 1, requestId: randomUUID() });
  await assert.rejects(save(actor, command({ code: input.code })), { status: 409, code: 'laboratory_code_exists' });
});

test('Lab exact requests serialize while stale, changed, cross-actor and rollback commands retain no extra history', async () => {
  const actor = await account(); const colleague = await account({ organizationId: actor.organizationId }); const input = command();
  const results = await Promise.all([save(actor, input), save(actor, input)]); assert.deepEqual(results[0], results[1]);
  await assert.rejects(save(actor, { ...input, name: 'Different' }), { status: 409, code: 'save_request_reused' });
  await assert.rejects(save(colleague, input), { status: 409, code: 'save_request_reused' });
  await assert.rejects(save(actor, { ...input, requestId: randomUUID() }), { status: 409, code: 'stale_laboratory' });
  await assert.rejects(work(actor, async (client, identity) => {
    await saveLaboratory(client, identity, { ...input, revision: 1, requestId: randomUUID(), name: 'Rolled back' }); throw new Error('Synthetic rollback');
  }), /Synthetic rollback/);
  assert.equal((await load(actor, input.id)).revision, 1);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM laboratory_versions WHERE organization_id=$1 AND laboratory_id=$2', [actor.organizationId, input.id])).rows[0].count, 1);
});

test('Lab lists and histories enforce reader/tenant boundaries, literal filtering and safe query shapes', async () => {
  const actor = await account(); const reader = await account({ organizationId: actor.organizationId, permissions: ['users.read'] }); const other = await account();
  const input = command({ name: 'Literal %_ Lab', description: 'Details exact' }); const original = await save(actor, input);
  await save(actor, command({ name: 'Second Lab', active: false }));
  assert.deepEqual(await load(reader, input.id, 1), original); await assert.rejects(save(reader, command()), { status: 403 });
  await assert.rejects(load(other, input.id), { status: 404 }); assert.equal((await list(other, {})).totalCount, 0);
  assert.equal((await list(reader, { search: '%_' })).totalCount, 1);
  assert.equal((await list(reader, { filters: { active: { type: 'boolean', value: 'false' } } })).totalCount, 1);
  assert.equal((await list(reader, { filters: { description: { type: 'text', value: 'Details' } } })).rows[0]._id, input.id);
  assert.equal((await list(reader, { page: 2, pageSize: 1, sort: { key: 'name', dir: 'asc' } })).rows[0].name, 'Second Lab');
  for (const query of [{ sort: { key: 'saved_by', dir: 'asc' } }, { filters: { active: { type: 'boolean', value: true } } }, { pageSize: 101 }]) await assert.rejects(list(reader, query), { status: 400 });
});

test('Lab SQL boundaries forbid direct writes, forged history and worker/public execution', async () => {
  const actor = await account(); const input = command(); await save(actor, input);
  for (const query of ["UPDATE laboratories SET name='forged',revision=revision+1", "INSERT INTO laboratory_versions DEFAULT VALUES", "DELETE FROM laboratory_versions"]) {
    await assert.rejects(work(actor, client => client.query(query)), { code: '42501' });
  }
  await assert.rejects(owner.query("UPDATE laboratory_versions SET name='forged' WHERE organization_id=$1", [actor.organizationId]), { code: '23514' });
  await assert.rejects(owner.query("UPDATE laboratories SET name='without history',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, input.id]), { code: '23514' });
  const privileges = (await owner.query("SELECT proname,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,has_function_privilege('public',oid,'EXECUTE') AS public FROM pg_proc WHERE proname IN ('users_write_laboratory','users_guard_laboratory_history','users_check_laboratory_history') ORDER BY proname")).rows;
  assert.equal(privileges.length, 3); assert(privileges.every(row => !row.worker && !row.public));
});

test('Lab retirement retains parameter history and rejects unavailable selections while exact retries still succeed', async () => {
  const actor = await account(); const lab = command(); await save(actor, lab);
  const input = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Linked parameter', key: randomUUID(), schemeAbbreviation: 'LP', order: 0, laboratoryId: lab.id };
  await work(actor, (client, identity) => saveTestParameter(client, identity, input));
  const original = await work(actor, (client, identity) => loadTestParameter(client, identity, input.id, { atRevision: 1 }));
  await retire(actor, { id: lab.id, revision: 1, requestId: randomUUID() });
  assert.deepEqual(await work(actor, (client, identity) => saveTestParameter(client, identity, input)), original);
  await assert.rejects(work(actor, (client, identity) => saveTestParameter(client, identity, { ...input, revision: 1, requestId: randomUUID(), description: 'Unchanged retired selection' })), { status: 400, code: 'invalid_laboratory' });
  await work(actor, (client, identity) => saveTestParameter(client, identity, { ...input, revision: 1, requestId: randomUUID(), laboratoryId: null }));
  assert.deepEqual(await work(actor, (client, identity) => loadTestParameter(client, identity, input.id, { atRevision: 1 })), original);
});

test('Lab reference observations wait for user changes and the writer rechecks an actor deactivated while waiting', async () => {
  for (const deactivateActor of [false, true]) {
    const actor = await account(); const person = deactivateActor ? actor : await account({ organizationId: actor.organizationId, permissions: [] });
    const input = command({ headUserId: person.userId }); const blocker = await owner.connect(); let pending; let pid; let pendingError;
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE users SET display_name=$2,active=$3 WHERE id=$1', [person.userId, 'Observed after wait', !deactivateActor]);
      pending = work(actor, async (client, identity) => {
        pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return saveLaboratory(client, identity, input);
      });
      void pending.catch(error => { pendingError = error; }); let waiting = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (pendingError) throw pendingError;
        if (pid && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(waiting, 'Lab writer reached the held user lock'); await blocker.query('COMMIT');
      if (deactivateActor) {
        await assert.rejects(pending, { status: 403 });
        assert.equal((await owner.query('SELECT 1 FROM laboratories WHERE organization_id=$1 AND id=$2', [actor.organizationId, input.id])).rowCount, 0);
      } else assert.equal((await pending).headUserName, 'Observed after wait');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  }
});
