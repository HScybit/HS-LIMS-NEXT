import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const base = { autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null };
const row = (changes = {}) => ({ id: randomUUID(), serviceCode: 'calibration', displayLabel: 'Calibration', isActive: true, ...changes });
const work = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions: ['settings.manage'], ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
const read = async user => (await work(user, loadLaboratorySettings, true)).settings;
const save = (user, input) => work(user, (client, identity) => saveLaboratorySettings(client, identity, { ...base, ...input }));
const history = async user => (await owner.query('SELECT revision,row_count,saved_by,saved_at,created_transaction_id::text FROM organization_instrument_service_versions WHERE organization_id=$1 ORDER BY revision', [user.organizationId])).rows;

test('absent settings read without writes; ordered definitions save with real actor and survive omitted lists', async () => {
  const user = await account(); assert.deepEqual((await read(user)).instrumentServiceTypes, []); assert.deepEqual(await history(user), []);
  const entries = [row({ serviceCode: 'PM-1', isActive: false }), row()];
  const result = await save(user, { revision: 0, instrumentServiceTypes: entries, dateFormat: 'YYYY-MM-DD' }); assert.equal(result.revision, 1);
  assert.deepEqual((await read(user)).instrumentServiceTypes, entries);
  const recorded = await history(user); assert.equal(recorded.length, 1); assert.equal(recorded[0].saved_by, user.userId); assert.equal(recorded[0].row_count, 2);
  assert(recorded[0].saved_at instanceof Date); assert.match(recorded[0].created_transaction_id, /^\d+$/);
  await save(user, { revision: 1, dateFormat: 'DD/MM/YYYY' });
  assert.deepEqual((await read(user)).instrumentServiceTypes, entries); assert.deepEqual(await history(user), recorded);
});

test('rename, reorder, Active, removal and explicit clearing preserve every earlier definition', async () => {
  const user = await account(); const first = row(); const second = row({ serviceCode: 'PM', displayLabel: 'Maintenance' });
  await save(user, { revision: 0, instrumentServiceTypes: [first, second] });
  const next = [{ ...second, isActive: false }, { ...first, serviceCode: 'CAL', displayLabel: 'Renamed' }];
  await save(user, { revision: 1, instrumentServiceTypes: next }); assert.deepEqual((await read(user)).instrumentServiceTypes, next);
  await save(user, { revision: 2, instrumentServiceTypes: [next[0]] }); await save(user, { revision: 3, instrumentServiceTypes: [] });
  assert.deepEqual((await read(user)).instrumentServiceTypes, []);
  assert.deepEqual((await history(user)).map(item => item.row_count), [2, 2, 1, 0]);
  const old = (await owner.query('SELECT id,service_code,display_label,active FROM organization_instrument_service_entries WHERE organization_id=$1 AND revision=1 ORDER BY position', [user.organizationId])).rows;
  assert.deepEqual(old, [first, second].map(item => ({ id: item.id, service_code: item.serviceCode, display_label: item.displayLabel, active: item.isActive })));
});

test('invalid or stale service submissions cannot partially save another settings tab', async () => {
  const user = await account(); const entry = row(); await save(user, { revision: 0, instrumentServiceTypes: [entry], dateFormat: 'YYYY' });
  for (const entries of [[entry, row({ serviceCode: 'CALIBRATION' })], [row({ displayLabel: '' })], Array.from({ length: 101 }, (_, i) => row({ serviceCode: String(i) }))]) {
    await assert.rejects(save(user, { revision: 1, instrumentServiceTypes: entries, dateFormat: 'MM' }), error => error.status === 400);
  }
  await assert.rejects(save(user, { revision: 0, instrumentServiceTypes: [], dateFormat: 'MM' }), error => error.code === 'stale_settings');
  const saved = await read(user); assert.equal(saved.revision, 1); assert.equal(saved.dateFormat, 'YYYY'); assert.deepEqual(saved.instrumentServiceTypes, [entry]); assert.equal((await history(user)).length, 1);
});

test('a database snapshot failure rolls back the preceding laboratory settings write', async () => {
  const user = await account(); await save(user, { revision: 0, dateFormat: 'YYYY' });
  await assert.rejects(work(user, (client, identity) => saveLaboratorySettings({ query(sql, args) {
    if (sql.startsWith('SELECT organization_save_instrument_services')) return client.query(sql, [args[0], args[1], [], args[3], args[4]]);
    return client.query(sql, args);
  } }, identity, { ...base, revision: 1, dateFormat: 'MM', instrumentServiceTypes: [row()] })), error => error.constraint === 'instrument_services_input');
  assert.equal((await read(user)).dateFormat, 'YYYY'); assert.equal((await read(user)).revision, 1); assert.deepEqual(await history(user), []);
});

test('same-organization concurrent writers return one success and one stale revision', async () => {
  const first = await account(); const second = await account({ organizationId: first.organizationId });
  const outcomes = await Promise.allSettled([save(first, { revision: 0, instrumentServiceTypes: [row()] }), save(second, { revision: 0, instrumentServiceTypes: [row({ serviceCode: 'PM' })] })]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'stale_settings');
  assert.equal((await history(first)).length, 1); assert.equal((await read(first)).revision, 1);
});

test('read-only and foreign-tenant identities cannot write or see another organization history', async () => {
  const manager = await account(); const entry = row(); await save(manager, { revision: 0, instrumentServiceTypes: [entry] });
  const reader = await account({ organizationId: manager.organizationId, permissions: ['settings.read'] }); const foreign = await account();
  assert.deepEqual((await read(reader)).instrumentServiceTypes, [entry]);
  await assert.rejects(save(reader, { revision: 1, instrumentServiceTypes: [] }), error => error.status === 403);
  assert.deepEqual(await work(foreign, async client => (await client.query('SELECT * FROM organization_instrument_service_entries WHERE organization_id=$1', [manager.organizationId])).rows, true), []);
  await assert.rejects(work(reader, client => client.query('SELECT organization_save_instrument_services(1,ARRAY[]::uuid[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::boolean[])')), error => error.code === '42501');
  const denied = await account({ permissions: [] }); await assert.rejects(work(denied, loadLaboratorySettings, true), error => error.status === 403);
});

test('history is immutable, direct application DML is denied and worker/PUBLIC privileges are absent', async () => {
  const user = await account(); await save(user, { revision: 0, instrumentServiceTypes: [row()] });
  for (const table of ['organization_instrument_service_versions', 'organization_instrument_service_entries']) {
    for (const sql of [`DELETE FROM ${table} WHERE organization_id=$1`, `UPDATE ${table} SET revision=revision WHERE organization_id=$1`]) {
      await assert.rejects(owner.query(sql, [user.organizationId]), error => error.code === '55000');
      await assert.rejects(work(user, client => client.query(sql, [user.organizationId])), error => error.code === '42501');
    }
    const privileges = (await owner.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS worker,has_table_privilege($3,$2,\'INSERT\') AS insert', ['sampleify_report_worker', table, 'sampleify_app'])).rows[0];
    assert.deepEqual(privileges, { worker: false, insert: false });
  }
  await assert.rejects(work(user, client => client.query('SELECT organization_save_instrument_services(1,ARRAY[]::uuid[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::boolean[])')), error => error.constraint === 'instrument_services_current_settings');
});

test('full source limits load in three queries and save in five action queries', async () => {
  const user = await account(); const rows = Array.from({ length: 100 }, (_, index) => row({ serviceCode: String(index).padStart(64, 'A'), displayLabel: 'L'.repeat(150) }));
  await work(user, async (client, identity) => {
    let calls = 0; const counted = { query(...args) { calls++; return client.query(...args); } };
    await saveLaboratorySettings(counted, identity, { ...base, revision: 0, instrumentServiceTypes: rows }); assert.equal(calls, 5);
    calls = 0; const result = await loadLaboratorySettings(counted, identity); assert.equal(calls, 3); assert.deepEqual(result.settings.instrumentServiceTypes, rows);
  });
});

test('the writer command rejects forged session context and a just-revoked account', async () => {
  const user = await account(); const foreign = await account();
  for (const [setting, value] of [['app.user_id', foreign.userId], ['app.organization_id', foreign.organizationId], ['app.session_id', randomUUID()]]) {
    await assert.rejects(work(user, async client => {
      await client.query('SELECT set_config($1,$2,true)', [setting, value]);
      await client.query('SELECT organization_lock_settings_writer()');
    }), error => error.code === '42501');
  }
  await assert.rejects(work(user, async client => {
    await owner.query('UPDATE users SET must_change_password=true WHERE id=$1', [user.userId]);
    await client.query('SELECT organization_lock_settings_writer()');
  }), error => error.constraint === 'organization_settings_session_required');
  const functions = (await owner.query(`SELECT proname,
    has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) privilege WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE') AS public
    FROM pg_proc WHERE proname IN ('organization_lock_settings_writer','organization_save_instrument_services','organization_guard_instrument_service_history') ORDER BY proname`)).rows;
  assert.equal(functions.length, 3); assert(functions.every(item => !item.worker && !item.public));
});
