import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveMethod, retireMethod } from '../../src/masters/methods.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function fixture() {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const field = await work(actor, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'method_note', label: 'Method note', fieldType: 'text', associatedWith: 'method_of_analysis' }));
  const initial = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Method boundary', uuid: randomUUID(),
    customFields: [{ fieldId: field.id, fieldRevision: field.revision, value: 'Original' }] };
  const saved = await work(actor, (client, identity) => saveMethod(client, identity, initial));
  return { actor, field, initial, saved };
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

for (const operation of ['api', 'retry', 'retire', 'sql']) test(`Method ${operation} rechecks permission and session loss after a definition wait`, async () => {
  for (const loss of ['permission', 'session']) {
    const f = await fixture();
    const update = (client, identity) => client.query(`UPDATE methods_of_analysis SET name='Queued Method',revision=revision+1,
      save_request_id=$3,custom_fields_provided=false,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`,
    [identity.organization_id, f.saved.id, randomUUID()]);
    if (operation === 'sql') {
      await work(f.actor, (client, identity) => retireCustomField(client, identity, { id: f.field.id, revision: 1, requestId: randomUUID() }));
      await work(f.actor, update);
    }
    const expectedRevision = operation === 'sql' ? 2 : 1;
    const holder = await owner.connect(); const ready = deferred(); let pending; let result;
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [f.actor.organizationId]);
      pending = settle(work(f.actor, async (client, identity) => {
        ready.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if (operation === 'api') return saveMethod(client, identity, { ...f.initial, revision: 1, requestId: randomUUID(), name: 'Queued' });
        if (operation === 'retry') return saveMethod(client, identity, f.initial);
        if (operation === 'retire') return retireMethod(client, identity, { id: f.saved.id, revision: 1, requestId: randomUUID() });
        return update(client, identity);
      }));
      const pid = await Promise.race([ready.promise, pending.then(() => null)]); assert.notEqual(pid, null); await waitForAdvisory(pid);
      if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.actor.organizationId, f.actor.roleId]);
      else await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1', [f.actor.userId]);
    } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) result = await pending; }
    assert(result.error, `${operation} accepted queued ${loss} loss.`);
    if (operation === 'sql') assert.equal(result.error.code, '42501');
    else { assert.equal(result.error.status, 403); assert.equal(result.error.code, 'forbidden'); }
    assert.equal((await owner.query('SELECT revision FROM methods_of_analysis WHERE organization_id=$1 AND id=$2', [f.actor.organizationId, f.saved.id])).rows[0].revision, expectedRevision);
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM method_versions WHERE organization_id=$1 AND method_id=$2', [f.actor.organizationId, f.saved.id])).rows[0].count, expectedRevision);
  }
});

test('Method captures reject incomplete or gapped children and preserve the preceding version', async () => {
  const f = await fixture();
  for (const defect of ['missing-field', 'missing-value', 'gapped-value']) {
    await assert.rejects(work(f.actor, (client, identity) => saveMethod({ query: (sql, args) => {
      if (defect === 'missing-field' && sql.startsWith('INSERT INTO method_version_custom_field')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.startsWith('INSERT INTO method_version_custom_field_values(')) {
        if (defect === 'missing-value') return Promise.resolve({ rows: [], rowCount: 0 });
        if (defect === 'gapped-value') {
          const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',');
          const changed = [...args]; changed[columns.indexOf('position')] = [1]; return client.query(sql, changed);
        }
      }
      return client.query(sql, args);
    } }, identity, { ...f.initial, revision: 1, requestId: randomUUID() })), { code: '23514' });
    assert.equal((await owner.query('SELECT revision FROM methods_of_analysis WHERE organization_id=$1 AND id=$2', [f.actor.organizationId, f.saved.id])).rows[0].revision, 1);
  }
});

test('Method writes reject old snapshots and captured rows keep their authenticated tenant throughout a statement', async () => {
  const f = await fixture(); const foreign = await fixture();
  for (const isolation of ['READ COMMITTED', 'READ UNCOMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    const client = await getPool().connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const identity = (await client.query('SELECT * FROM auth_session_context($1)', [hashToken(f.actor.token)])).rows[0]; assert(identity);
      if (['READ COMMITTED', 'READ UNCOMMITTED'].includes(isolation)) {
        const saved = await saveMethod(client, identity, { ...f.initial, revision: 1, requestId: randomUUID() }); assert.equal(saved.revision, 2);
      } else {
        await assert.rejects(saveMethod(client, identity, f.initial), { code: 'method_field_write_isolation' });
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  for (const table of ['method_version_custom_fields', 'method_version_custom_field_values']) {
    await work(f.actor, async client => {
      await client.query('SET LOCAL enable_indexscan=off'); await client.query('SET LOCAL enable_bitmapscan=off');
      const rows = (await client.query(`SELECT organization_id,set_config('app.organization_id',$1,true) AS attempted_scope
        FROM ${table} WHERE method_id=ANY($2::uuid[])`, [foreign.actor.organizationId, [f.saved.id, foreign.saved.id]])).rows;
      assert.equal(rows.length, 1); assert(rows.every(row => row.organization_id === f.actor.organizationId));
    }, true);
  }
  const grants = (await owner.query(`SELECT has_function_privilege('sampleify_report_worker','masters_lock_method_field_writer()','EXECUTE') AS worker,
    has_table_privilege('sampleify_report_worker','method_version_custom_fields','SELECT') AS history`)).rows[0];
  assert.deepEqual(grants, { worker: false, history: false });
});
