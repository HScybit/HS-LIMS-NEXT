import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveTestParameter, loadTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action) => withSession(actor.token, action, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const actor = await account(); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Original Laboratory')", [actor.organizationId, lab]);
  return { actor, lab };
}
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'LAB-' + randomUUID().slice(0, 8),
  name: 'Parameter with laboratory', description: '', schemeAbbreviation: 'LAB-' + randomUUID().slice(0, 8), order: 0, laboratoryId: null, measurementUncertainty: null, ...changes });
const save = (actor, input) => work(actor, (client, identity) => saveTestParameter(client, identity, input));
const load = (actor, id, atRevision) => work(actor, (client, identity) => loadTestParameter(client, identity, id, atRevision === undefined ? {} : { atRevision }));

test('historical Lab labels and retries survive later renames while current editing uses current names', async () => {
  const { actor, lab } = await fixture(); const input = command({ laboratoryId: lab }); await save(actor, input);
  const original = await load(actor, input.id, 1); assert.equal(original.laboratoryName, 'Original Laboratory');
  await owner.query("UPDATE laboratories SET name='Current Laboratory',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, lab]);
  assert.equal((await load(actor, input.id)).laboratoryName, 'Current Laboratory');
  assert.deepEqual(await load(actor, input.id, 1), original); assert.deepEqual(await save(actor, input), original);
  await save(actor, { ...input, revision: 1, requestId: randomUUID(), description: 'New actual observation' });
  assert.equal((await load(actor, input.id, 2)).laboratoryName, 'Current Laboratory');
  assert.deepEqual(await load(actor, input.id, 1), original);
  const reader = await account({ organizationId: actor.organizationId, permissions: ['masters.read'] });
  assert.deepEqual(await load(reader, input.id, 1), original);
  const other = await account(); await assert.rejects(load(other, input.id, 1), { status: 404 });
});

test('missing, changed and removed laboratories retain their distinct observations through retirement', async () => {
  const { actor, lab } = await fixture(); const input = command(); await save(actor, input);
  assert.equal((await load(actor, input.id, 1)).laboratoryName, null);
  await save(actor, { ...input, revision: 1, requestId: randomUUID(), laboratoryId: lab });
  assert.equal((await load(actor, input.id, 2)).laboratoryName, 'Original Laboratory');
  await save(actor, { ...input, revision: 2, requestId: randomUUID() });
  assert.equal((await load(actor, input.id, 3)).laboratoryName, null);
  const assigned = command({ laboratoryId: lab }); await save(actor, assigned);
  await owner.query("UPDATE laboratories SET active=false,name='Retired Laboratory',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, lab]);
  await work(actor, (client, identity) => retireTestParameter(client, identity, { id: assigned.id, requestId: randomUUID(), revision: 1 }));
  assert.equal((await load(actor, assigned.id, 1)).laboratoryName, 'Original Laboratory');
  assert.equal((await load(actor, assigned.id, 2)).laboratoryName, 'Retired Laboratory');
  assert.equal((await load(actor, assigned.id, 2)).operation, 'retire');
});

test('unknown historical labels remain NULL and cannot be filled from today’s Lab name', async () => {
  const { actor, lab } = await fixture(); const id = randomUUID();
  // An explicit synthetic owner fixture represents a version predating label observations.
  await owner.query("INSERT INTO test_parameters(organization_id,id,code,name,master_key,scheme_abbreviation,laboratory_id) VALUES($1,$2::uuid,$2::text,'Legacy parameter',$2::text,'LEGACY',$3)", [actor.organizationId, id, lab]);
  await owner.query(`INSERT INTO test_parameter_versions(organization_id,parameter_id,revision,request_id,previous_revision,operation,code,name,description,
    master_key,scheme_abbreviation,display_order,active,laboratory_id,measurement_unit_id,default_scale,has_uncertainty,saved_by)
    SELECT organization_id,id,revision,$3,NULL,'create',code,name,description,master_key,scheme_abbreviation,display_order,active,laboratory_id,
      measurement_unit_id,default_scale,false,$4 FROM test_parameters WHERE organization_id=$1 AND id=$2`, [actor.organizationId, id, randomUUID(), actor.userId]);
  assert.equal((await load(actor, id, 1)).laboratoryId, lab); assert.equal((await load(actor, id, 1)).laboratoryName, null);
  await owner.query("UPDATE laboratories SET name='Renamed legacy laboratory',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, lab]);
  assert.equal((await load(actor, id, 1)).laboratoryName, null);
  await assert.rejects(owner.query("UPDATE test_parameter_versions SET laboratory_name='Invented' WHERE organization_id=$1 AND parameter_id=$2", [actor.organizationId, id]), { code: '55000' });
});

test('snapshot creation retains exact legacy Lab text and existing SQL write boundaries', async () => {
  const { actor, lab } = await fixture(); const label = '  ' + 'L'.repeat(250) + '  ';
  await owner.query('UPDATE laboratories SET name=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, lab, label]);
  const input = command({ laboratoryId: lab }); await save(actor, input); assert.equal((await load(actor, input.id, 1)).laboratoryName, label);
  await assert.rejects(work(actor, client => client.query("UPDATE test_parameter_versions SET laboratory_name='Forged' WHERE organization_id=$1", [actor.organizationId])), { code: '42501' });
  await assert.rejects(work(actor, client => client.query('SELECT masters_capture_parameter_laboratory_label()')), { code: '42501' });
  const grants = (await owner.query("SELECT has_function_privilege('sampleify_report_worker','masters_capture_parameter_laboratory_label()','EXECUTE') AS worker,has_function_privilege('public','masters_capture_parameter_laboratory_label()','EXECUTE') AS public")).rows[0];
  assert.deepEqual(grants, { worker: false, public: false });
});

test('a concurrent Lab rename is observed after the reference lock and a failed parameter command rolls back', async () => {
  const { actor, lab } = await fixture(); const input = command({ laboratoryId: lab }); const blocker = await owner.connect();
  let pending; let pid; let pendingError;
  try {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE laboratories SET name='Committed concurrent name',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, lab]);
    pending = work(actor, async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return saveTestParameter(client, identity, input);
    });
    void pending.catch(error => { pendingError = error; }); let waiting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (pendingError) throw pendingError;
      if (pid && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(waiting, 'Parameter save reached the held Lab reference lock.'); await blocker.query('COMMIT'); await pending;
    assert.equal((await load(actor, input.id, 1)).laboratoryName, 'Committed concurrent name');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  await assert.rejects(work(actor, async (client, identity) => {
    await saveTestParameter(client, identity, { ...input, revision: 1, requestId: randomUUID(), description: 'Rolled back' });
    throw new Error('Synthetic rollback');
  }), /Synthetic rollback/);
  assert.equal((await load(actor, input.id)).revision, 1);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM test_parameter_versions WHERE organization_id=$1 AND parameter_id=$2', [actor.organizationId, input.id])).rows[0].count, 1);
});
