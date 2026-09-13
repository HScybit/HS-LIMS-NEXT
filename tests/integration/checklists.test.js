import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, transaction } from '../../src/db/pool.js';
import { createChecklist, updateChecklist, retireChecklist, loadChecklist, listChecklists } from '../../src/checklists/service.js';

const owner = ownerPool(); let manager; let reader; let outsider; let noAccess;
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Synthetic checklist ${randomUUID()}`,
  items: [{ id: randomUUID(), prompt: 'First check' }, { id: randomUUID(), prompt: 'Second check' }], ...changes });
const work = (callback, account = manager, readOnly = false) => withSession(account.token, callback, { csrfToken: account.csrfToken, readOnly });
async function account(options) {
  const value = await createAccount(owner, options); Object.assign(value, await signIn({ identifier: value.username, password: value.password })); return value;
}
const raw = (client, input = command(), operation = 'create') => client.query('SELECT checklists_write($1,$2,$3,$4,$5,$6,$7,$8)',
  [operation, input.id, input.revision, input.requestId, input.name ?? null, input.isActive ?? null,
    input.items?.map((item) => item.id) ?? null, input.items?.map((item) => item.prompt) ?? null]);

before(async () => {
  manager = await account({ permissions: ['checklists.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['checklists.read'] });
  noAccess = await account({ organizationId: manager.organizationId, permissions: [] });
  outsider = await account({ permissions: ['checklists.read', 'checklists.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('Checklist Master stores ordered stable items with actual history, optional edits and inactive reactivation', async () => {
  const input = command({ name: ' Checklist – जल ', isActive: false }); input.items[0].prompt = '  0  ';
  assert.deepEqual(await work((client, identity) => createChecklist(client, identity, input)), { id: input.id, revision: 1 });
  const first = await work((client, identity) => loadChecklist(client, identity, input.id, { atRevision: 1 }), reader, true);
  assert.equal(first.savedBy, manager.userId); assert(first.savedAt instanceof Date); assert.equal(first.operation, 'create'); assert.equal(first.previousRevision, null);
  assert.equal(first.name, 'Checklist – जल'); assert.equal(first.isActive, false); assert.equal(first.items[0].prompt, '0');
  const current = await work((client, identity) => loadChecklist(client, identity, input.id.toUpperCase()), reader, true);
  assert.equal(current.createdBy, manager.userId); assert.equal(+current.createdAt, +first.savedAt);
  const edit = { id: input.id, requestId: randomUUID(), revision: 1, isActive: true };
  assert.equal((await work((client, identity) => updateChecklist(client, identity, edit))).revision, 2);
  const second = await work((client, identity) => loadChecklist(client, identity, input.id));
  assert.equal(second.name, first.name); assert.equal(second.isActive, true); assert.deepEqual(second.items, first.items);
  assert.equal(+second.createdAt, +current.createdAt); assert.equal(second.createdBy, current.createdBy);
  const items = [{ id: input.items[1].id, prompt: 'Edited second' }, { id: input.items[0].id, prompt: '0' }, { id: randomUUID(), prompt: 'New check' }];
  await work((client, identity) => updateChecklist(client, identity, { id: input.id, requestId: randomUUID(), revision: 2, items }));
  assert.deepEqual((await work((client, identity) => loadChecklist(client, identity, input.id))).items, items.map((item, displayOrder) => ({ ...item, displayOrder })));
  assert.deepEqual(await work((client, identity) => loadChecklist(client, identity, input.id, { atRevision: 1 }), reader, true), first);
});

test('Checklist Master recovers exact requests after later saves and retirement and rejects changed actor or payload', async () => {
  const input = command(); const created = await work((client, identity) => createChecklist(client, identity, input));
  assert.equal((await work((client, identity) => loadChecklist(client, identity, input.id))).isActive, true);
  const edit = { id: input.id, requestId: randomUUID(), revision: 1, name: 'A later name', items: input.items.slice().reverse() };
  const changed = await work((client, identity) => updateChecklist(client, identity, edit));
  const removal = { id: input.id, requestId: randomUUID(), revision: 2 }; const retired = await work((client, identity) => retireChecklist(client, identity, removal));
  assert.deepEqual(await work((client, identity) => createChecklist(client, identity, input)), created);
  assert.deepEqual(await work((client, identity) => updateChecklist(client, identity, edit)), changed);
  assert.deepEqual(await work((client, identity) => retireChecklist(client, identity, removal)), retired);
  for (const change of [{ id: randomUUID() }, { name: 'Different' }, { isActive: true }, { items: input.items.slice().reverse() },
    { items: [{ id: randomUUID(), prompt: 'First check' }, input.items[1]] }]) {
    await assert.rejects(work((client, identity) => createChecklist(client, identity, { ...input, ...change })), { code: 'save_request_reused' });
  }
  const otherManager = await account({ organizationId: manager.organizationId, permissions: ['checklists.manage'] });
  await assert.rejects(work((client, identity) => createChecklist(client, identity, input), otherManager), { code: 'save_request_reused' });
  await assert.rejects(work((client, identity) => loadChecklist(client, identity, input.id)), { code: 'checklist_not_found' });
  await assert.rejects(work((client, identity) => updateChecklist(client, identity, { id: input.id, requestId: randomUUID(), revision: 3, isActive: true })), { code: 'checklist_not_found' });
  const history = await work((client, identity) => loadChecklist(client, identity, input.id, { atRevision: 3 }));
  assert.equal(history.isActive, true); assert.equal(+history.retiredAt, +history.savedAt); assert.equal(history.operation, 'retire');
  assert.equal((await work((client, identity) => listChecklists(client, identity, { search: 'A later name' }))).totalCount, 0);
});

test('Checklist Master enforces tenant access, manage-only editing and read-only database privileges', async () => {
  const input = command(); await work((client, identity) => createChecklist(client, identity, input));
  for (const atRevision of [undefined, 1]) await assert.rejects(work((client, identity) => loadChecklist(client, identity, input.id, { atRevision }), outsider, true), { code: 'checklist_not_found' });
  await assert.rejects(work((client, identity) => updateChecklist(client, identity, { ...input, requestId: randomUUID(), revision: 1 }), outsider), { code: 'checklist_not_found' });
  await assert.rejects(work((client, identity) => retireChecklist(client, identity, { id: input.id, requestId: randomUUID(), revision: 1 }), outsider), { code: 'checklist_not_found' });
  await assert.rejects(work(listChecklists, noAccess, true), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => createChecklist(client, identity, command()), reader), { code: 'forbidden' });
  await assert.rejects(work((client) => raw(client), reader), { code: '42501', constraint: 'checklist_session_required' });
  await work(async (client) => { for (const table of ['checklists', 'checklist_items', 'checklist_versions', 'checklist_version_items']) assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0); }, noAccess, true);
  for (const table of ['checklists', 'checklist_items', 'checklist_versions', 'checklist_version_items']) {
    for (const role of ['sampleify_app', 'sampleify_report_worker']) assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, 'INSERT,UPDATE,DELETE,TRUNCATE'])).rows[0].allowed, false);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', table, 'SELECT'])).rows[0].allowed, false);
  }
  const functions = (await owner.query("SELECT proname,has_function_privilege('sampleify_app',oid,'EXECUTE') AS app,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'checklists_%'")).rows;
  assert.equal(functions.length, 8);
  for (const fn of functions) { assert.equal(fn.app, fn.proname === 'checklists_write'); assert.equal(fn.worker, false); assert.equal(fn.public, false); }
});

test('Checklist Master serializes same-name creation and stale edits, retaining case-sensitive and inactive names', async () => {
  const name = `Concurrent ${randomUUID()}`;
  const inputs = [command({ name, isActive: false }), command({ name })];
  const results = await Promise.allSettled(inputs.map((input) => work((client, identity) => createChecklist(client, identity, input))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'duplicate_checklist_name');
  const id = results.find((result) => result.status === 'fulfilled').value.id;
  const edits = await Promise.allSettled([true, false].map((isActive) => work((client, identity) => updateChecklist(client, identity, { id, requestId: randomUUID(), revision: 1, isActive }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_checklist');
  await work((client, identity) => createChecklist(client, identity, command({ name: name.toLowerCase() })));
  await work((client, identity) => createChecklist(client, identity, command({ name })), outsider);
  await work((client, identity) => retireChecklist(client, identity, { id, requestId: randomUUID(), revision: 2 }));
  await work((client, identity) => createChecklist(client, identity, command({ name })));
});

test('Checklist Master preserves imported revision zero without inventing history or normalizing omitted items', async () => {
  const id = randomUUID(); const itemId = randomUUID(); const name = `Legacy ${randomUUID()}`;
  await owner.query('INSERT INTO checklists(organization_id,id,name,is_active) VALUES($1,$2,$3,false)', [manager.organizationId, id, name]);
  await owner.query('INSERT INTO checklist_items(organization_id,checklist_id,id,prompt,display_order) VALUES($1,$2,$3,$4,4)', [manager.organizationId, id, itemId, '  ']);
  await owner.query('INSERT INTO checklists(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, randomUUID(), name]);
  await assert.rejects(work((client, identity) => loadChecklist(client, identity, id, { atRevision: 1 })), { code: 'checklist_not_found' });
  const before = await work((client, identity) => loadChecklist(client, identity, id));
  assert.equal(before.revision, 0); assert.equal(before.createdAt, null); assert.equal(before.createdBy, null);
  await work((client, identity) => updateChecklist(client, identity, { id, requestId: randomUUID(), revision: 0, name, isActive: true }));
  const after = await work((client, identity) => loadChecklist(client, identity, id));
  assert.deepEqual(after.items, before.items); assert.equal(after.createdAt, null); assert.equal(after.createdBy, null);
  const version = await work((client, identity) => loadChecklist(client, identity, id, { atRevision: 1 }));
  assert.equal(version.previousRevision, 0); assert.equal(version.operation, 'update'); assert.equal(version.savedBy, manager.userId);
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM checklist_versions WHERE checklist_id=$1', [id])).rows[0].n, 1);
});

test('Checklist Master enforces live authority rather than forged, stale or revoked session context', async () => {
  await assert.rejects(transaction(async (client) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [manager.organizationId, manager.userId]); await raw(client);
  }), { code: '42501', constraint: 'checklist_session_required' });
  await assert.rejects(work(async (client) => { await client.query("SELECT set_config('app.user_id',$1,true)", [manager.userId]); await raw(client); }, reader), { code: '42501', constraint: 'checklist_session_required' });
  for (const invalidation of ['revoked', 'expired', 'credential', 'inactive_member', 'inactive_user', 'inactive_organization', 'password_change']) {
    const actor = await account({ permissions: ['checklists.manage'] });
    await assert.rejects(work(async (client, identity) => {
      if (invalidation === 'revoked') await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      else if (invalidation === 'expired') await owner.query("UPDATE sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1", [actor.userId]);
      else if (invalidation === 'credential') await owner.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [actor.userId]);
      else if (invalidation === 'inactive_member') await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, actor.userId]);
      else if (invalidation === 'inactive_user') await owner.query('UPDATE users SET active=false WHERE id=$1', [actor.userId]);
      else if (invalidation === 'inactive_organization') await owner.query('UPDATE organizations SET active=false WHERE id=$1', [actor.organizationId]);
      else await owner.query('UPDATE users SET must_change_password=true WHERE id=$1', [actor.userId]);
      await createChecklist(client, identity, command());
    }, actor), { code: 'forbidden' }, invalidation);
  }
});

test('Checklist Master rejects direct malformed SQL arrays and preserves all 200 item identities and Unicode API semantics', async () => {
  const base = command();
  for (const input of [{ ...base, items: [] }, { ...base, items: [{ id: null, prompt: 'x' }] }, { ...base, items: [base.items[0], base.items[0]] },
    { ...base, items: [{ id: randomUUID(), prompt: 'x' }, { id: randomUUID(), prompt: 'x' }] }, { ...base, items: [{ id: randomUUID(), prompt: '' }] },
    { ...base, items: Array.from({ length: 201 }, (_, index) => ({ id: randomUUID(), prompt: String(index) })) }]) {
    await assert.rejects(work((client) => raw(client, input)), { code: '23514', constraint: 'checklist_invalid_input' });
  }
  const input = command({ items: Array.from({ length: 200 }, (_, index) => ({ id: randomUUID(), prompt: `${index}`.padEnd(500, 'a') })) });
  await work((client, identity) => createChecklist(client, identity, input));
  assert.deepEqual((await work((client, identity) => loadChecklist(client, identity, input.id))).items, input.items.map((item, displayOrder) => ({ ...item, displayOrder })));
  await work((client, identity) => createChecklist(client, identity, command({ items: ['İ', 'i', 'ß', 'SS', 'é', 'e\u0301'].map((prompt) => ({ id: randomUUID(), prompt })) })));
  await assert.rejects(work((client, identity) => createChecklist(client, identity, command({ items: ['İ', 'i\u0307'].map((prompt) => ({ id: randomUUID(), prompt })) }))), { code: 'duplicate_checklist_items' });
});

test('a checklist command waiting on the organization lock rechecks revoked manager authority', async () => {
  const actor = await account({ permissions: ['checklists.manage'] }); const lock = await owner.connect(); const input = command(); let pending; let pid;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor.organizationId]);
    let signalStarted; const started = new Promise((resolve) => { signalStarted = resolve; });
    pending = work(async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; signalStarted(); return createChecklist(client, identity, input);
    }, actor).then((result) => ({ result }), (error) => ({ error })).finally(signalStarted);
    await started; assert.ok(pid, 'the authenticated callback started');
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'the command reached the actual organization lock');
    await lock.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='checklists.manage'", [actor.organizationId, actor.roleId]);
    await lock.query('COMMIT'); assert.equal((await pending).error?.code, 'forbidden');
    assert.equal((await owner.query('SELECT count(*)::integer AS n FROM checklists WHERE id=$1', [input.id])).rows[0].n, 0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending; }
});

test('Checklist Master keeps literal name searching, combined filters, sorting and far-page totals bounded', async () => {
  const actor = await account({ permissions: ['checklists.manage'] });
  for (const [name, isActive] of [['Prefix %_\\ one', false], ['Prefix %_\\ two', true], ['Prefix xx one', true]]) await work((client, identity) => createChecklist(client, identity, command({ name, isActive })), actor);
  const result = await work((client, identity) => listChecklists(client, identity, { search: '%_\\', sort: { key: 'name', dir: 'desc' } }), actor, true);
  assert.equal(result.totalCount, 2); assert.deepEqual(result.rows.map((row) => row.name), ['Prefix %_\\ two', 'Prefix %_\\ one']);
  assert.equal(result.rows[1].isActive, false); assert.equal(Object.hasOwn(result.rows[0], 'items'), false);
  assert.equal((await work((client, identity) => listChecklists(client, identity, { search: '%_\\', filters: { name: { type: 'text', value: 'Prefix one' } } }), actor, true)).totalCount, 1);
  const empty = await work((client, identity) => listChecklists(client, identity, { page: 1000000, pageSize: 100 }), actor, true);
  assert.equal(empty.totalCount, 3); assert.deepEqual(empty.rows, []);
  assert.equal((await work((client, identity) => listChecklists(client, identity, { sort: { key: 'isActive', dir: 'asc' } }), actor, true)).rows[0].isActive, false);
  assert.equal((await work((client, identity) => listChecklists(client, identity, { filters: { isActive: { type: 'boolean', value: 'false' } } }), actor, true)).totalCount, 1);
});

test('Checklist Master rolls back complete saves on asynchronous failure and denies owner mutation of saved history', async () => {
  const input = command();
  await assert.rejects(work(async (client, identity) => { await createChecklist(client, identity, input); await Promise.reject(new Error('Synthetic post-save failure')); }), /Synthetic post-save failure/);
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM checklists WHERE id=$1', [input.id])).rows[0].n, 0);
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM checklist_versions WHERE request_id=$1', [input.requestId])).rows[0].n, 0);
  await work((client, identity) => createChecklist(client, identity, input));
  for (const table of ['checklist_versions', 'checklist_version_items']) {
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE checklist_id=$1`, [input.id]), { code: '55000' });
    await assert.rejects(owner.query(`UPDATE ${table} SET revision=revision WHERE checklist_id=$1`, [input.id]), { code: '55000' });
  }
  await assert.rejects(owner.query('DELETE FROM checklists WHERE id=$1', [input.id]), { code: '55000' });
  await assert.rejects(owner.query('UPDATE checklists SET revision=revision+1,name=$2 WHERE id=$1', [input.id, 'Unaudited']), { code: '23514' });
  await assert.rejects(owner.query('DELETE FROM checklist_items WHERE checklist_id=$1', [input.id]), { code: '23514' });
  assert.equal((await work((client, identity) => loadChecklist(client, identity, input.id))).revision, 1);
});
