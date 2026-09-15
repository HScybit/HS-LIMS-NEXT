import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { registerSample } from '../../src/samples/register.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
const base = { autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null };
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['settings.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const read = async user => (await work(user, loadLaboratorySettings, true)).settings;
const save = (user, input) => work(user, (client, identity) => saveLaboratorySettings(client, identity, { ...base, ...input }));
const flag = async user => (await work(user, client => client.query('SELECT sample_receiving_date_edit_enabled() AS enabled'), true)).rows[0].enabled;

test('receiving-date settings default off without a row and old clients preserve explicit true and false', async () => {
  const user = await account(); const initial = await read(user); assert.equal(initial.allowReceivingDateEdit, false); assert.equal(initial.revision, 0);
  assert.equal((await owner.query('SELECT 1 FROM organization_laboratory_settings WHERE organization_id=$1', [user.organizationId])).rowCount, 0);
  await save(user, { revision: 0 }); assert.equal((await read(user)).allowReceivingDateEdit, false);
  let revision = 1;
  for (const enabled of [true, false]) {
    await save(user, { revision: revision++, allowReceivingDateEdit: enabled });
    await save(user, { revision: revision++ });
    const current = await read(user); assert.equal(current.allowReceivingDateEdit, enabled); assert.equal(current.revision, revision);
    assert.equal(current.updatedBy, user.userId); assert(current.updatedAt instanceof Date);
  }
});

test('invalid receiving-date flags fail without a write and concurrent or stale changes retain one winner', async () => {
  const user = await account();
  for (const allowReceivingDateEdit of [null, 0, 1, '', 'false', 'true', [], {}]) {
    await assert.rejects(save(user, { revision: 0, allowReceivingDateEdit }), error => error.status === 400);
    assert.equal((await read(user)).revision, 0);
  }
  await save(user, { revision: 0, allowReceivingDateEdit: true });
  const outcomes = await Promise.allSettled([true, false].map(allowReceivingDateEdit => save(user, { revision: 1, allowReceivingDateEdit })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'stale_settings');
  const current = await read(user); assert.equal(current.revision, 2); assert.equal(current.allowReceivingDateEdit, [true, false][outcomes.findIndex(outcome => outcome.status === 'fulfilled')]);
  await assert.rejects(save(user, { revision: 1, allowReceivingDateEdit: !current.allowReceivingDateEdit }), { code: 'stale_settings' });
  assert.deepEqual(await read(user), current);
});

test('sample-only clients receive the single organization flag with fixed query count and unchanged table access', async () => {
  const manager = await account(); await save(manager, { revision: 0, allowReceivingDateEdit: true, selfAllocationEnabled: true });
  const foreign = await account({ permissions: ['samples.create'] }); assert.equal(await flag(foreign), false);
  for (const permission of ['samples.create', 'samples.read']) {
    const user = await account({ organizationId: manager.organizationId, permissions: [permission] });
    let queries = 0;
    const options = await work(user, (client, identity) => sampleRegistrationOptions({ query: (...args) => { queries++; return client.query(...args); } }, identity), true);
    assert.equal(queries, 11); assert.equal(options.allowReceivingDateEdit, true); assert.equal(await flag(user), true);
    assert.equal(Object.hasOwn(options, 'selfAllocationEnabled'), false); assert.equal(Object.hasOwn(options, 'updatedBy'), false);
    // Existing laboratory reads include samples.read; creation alone still cannot read the table.
    assert.equal((await work(user, client => client.query('SELECT * FROM organization_laboratory_settings'), true)).rowCount, permission === 'samples.read' ? 1 : 0);
    await assert.rejects(work(user, loadLaboratorySettings, true), { code: 'forbidden' });
    await assert.rejects(save(user, { revision: 1, allowReceivingDateEdit: false }), { code: 'forbidden' });
  }
  assert.equal((await read(manager)).allowReceivingDateEdit, true);
});

test('receiving-date projection verifies actual authority and denies revoked, unauthenticated and worker access', async () => {
  const user = await account({ permissions: ['samples.create'] }); assert.equal(await flag(user), false);
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [user.organizationId, user.roleId]);
  await assert.rejects(work(user, (client, identity) => sampleRegistrationOptions(client, { ...identity, permission_codes: ['samples.create'] }), true), { code: '42501' });
  const manager = await account(); await assert.rejects(flag(manager), { code: '42501' });
  const denied = await account({ permissions: [] }); await assert.rejects(flag(denied), { code: '42501' });
  await assert.rejects(work(denied, sampleRegistrationOptions, true), { code: 'forbidden' });
  const client = await getPool().connect();
  try { await assert.rejects(client.query('SELECT sample_receiving_date_edit_enabled()'), { code: '42501' }); } finally { client.release(); }
  const privileges = (await owner.query("SELECT has_function_privilege('sampleify_app','sample_receiving_date_edit_enabled()','EXECUTE') AS app, has_function_privilege('sampleify_report_worker','sample_receiving_date_edit_enabled()','EXECUTE') AS worker")).rows[0];
  assert.deepEqual(privileges, { app: true, worker: false });
});

test('receiving-date setting keeps tenant, viewer and real-actor database boundaries', async () => {
  const user = await account(); await save(user, { revision: 0, allowReceivingDateEdit: true });
  const viewer = await account({ organizationId: user.organizationId, permissions: ['settings.read'] }); assert.equal((await read(viewer)).allowReceivingDateEdit, true);
  await assert.rejects(save(viewer, { revision: 1, allowReceivingDateEdit: false }), { code: 'forbidden' });
  const foreign = await account();
  assert.equal((await work(foreign, client => client.query('SELECT allow_receiving_date_edit FROM organization_laboratory_settings WHERE organization_id=$1', [user.organizationId]), true)).rowCount, 0);
  assert.equal((await work(foreign, client => client.query('UPDATE organization_laboratory_settings SET allow_receiving_date_edit=false,revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$1', [user.organizationId, foreign.userId]))).rowCount, 0);
  await assert.rejects(work(user, client => client.query('UPDATE organization_laboratory_settings SET allow_receiving_date_edit=false,revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$1', [user.organizationId, viewer.userId])), { code: '42501' });
  await assert.rejects(work(user, client => client.query('UPDATE organization_laboratory_settings SET allow_receiving_date_edit=NULL,revision=revision+1,updated_by=$2,updated_at=now() WHERE organization_id=$1', [user.organizationId, user.userId])), { code: '23502' });
  assert.equal((await read(user)).allowReceivingDateEdit, true); assert.equal((await read(user)).revision, 1);
});

test('registration preserves existing API date semantics when the UI date flag is off', async () => {
  const user = await account({ permissions: ['samples.create'] }); const fixture = await createLaboratoryFixture(owner, user);
  assert.equal(await flag(user), false); const sample = await work(user, (client, identity) => registerSample(client, identity, fixture.registration));
  const stored = (await owner.query('SELECT received_at FROM samples WHERE organization_id=$1 AND id=$2', [user.organizationId, sample.id])).rows[0];
  assert.equal(stored.received_at.toISOString(), new Date(fixture.registration.receivedAt).toISOString());
});
