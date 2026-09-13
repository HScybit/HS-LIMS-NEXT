import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, transaction } from '../../src/db/pool.js';
import { createRole, updateRole, retireRole, loadRole, listRoles, loadRoleSettings } from '../../src/roles/service.js';
import { roleCapabilityKeys } from '../../src/roles/capabilities.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { customFieldRoles } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); let manager; let reader; let outsider; let noAccess;
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Synthetic role ${randomUUID()}`, ...changes });
const work = (callback, account = manager, readOnly = false) => withSession(account.token, callback, { csrfToken: account.csrfToken, readOnly });
async function account(options) {
  const value = await createAccount(owner, options); Object.assign(value, await signIn({ identifier: value.username, password: value.password })); return value;
}
const raw = (client, input = command(), operation = 'create') => client.query('SELECT roles_write($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
  [operation, input.id, input.revision, input.requestId, input.name ?? null, input.description ?? null, input.description !== undefined,
    input.defaultPath ?? null, input.defaultPath !== undefined, input.permissionCodes ?? null, input.capabilityKeys ?? null]);

before(async () => {
  manager = await account({ permissions: ['roles.manage', 'settings.manage', 'masters.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['roles.read'] });
  noAccess = await account({ organizationId: manager.organizationId, permissions: [] });
  outsider = await account({ permissions: ['roles.read', 'roles.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

test('Role Master creates and revises typed metadata, preserving omitted grants and exact immutable history', async () => {
  const input = command({ name: 'Analyst – जल', description: '  0  ', defaultPath: ' /samples ', permissionCodes: ['templates.read'], capabilityKeys: ['can_admin', 'can_self_allocate'] });
  const created = await work((client, identity) => createRole(client, identity, input)); assert.deepEqual(created, { id: input.id, revision: 1 });
  const first = await work((client, identity) => loadRole(client, identity, input.id.toUpperCase(), { atRevision: 1 }), reader, true);
  assert.equal(first.description, '0'); assert.equal(first.defaultPath, '/samples'); assert.equal(first.savedBy, manager.userId);
  assert.equal(first.previousRevision, null); assert.equal(first.operation, 'create'); assert.deepEqual(first.permissionCodes, ['templates.read']);
  const edit = { id: input.id, requestId: randomUUID(), revision: 1, name: 'Renamed analyst' };
  assert.equal((await work((client, identity) => updateRole(client, identity, edit))).revision, 2);
  const current = await work((client, identity) => loadRole(client, identity, input.id), reader, true);
  assert.equal(current.description, first.description); assert.equal(current.defaultPath, first.defaultPath);
  assert.deepEqual(current.permissionCodes, first.permissionCodes); assert.deepEqual(current.capabilityKeys, first.capabilityKeys);
  assert.deepEqual(await work((client, identity) => loadRole(client, identity, input.id, { atRevision: 1 }), reader, true), first);
  assert.deepEqual(await work((client, identity) => createRole(client, identity, input)), created, 'a lost creation response replays its original revision after later edits');
  await assert.rejects(work((client, identity) => updateRole(client, identity, { ...edit, description: '0' })), { code: 'save_request_reused' });
  assert.equal((await work((client, identity) => updateRole(client, identity, { ...edit, revision: 2, requestId: randomUUID(), description: null, defaultPath: null,
    permissionCodes: [], capabilityKeys: [] }))).revision, 3);
  const cleared = await work((client, identity) => loadRole(client, identity, input.id), reader, true);
  assert.equal(cleared.description, ''); assert.equal(cleared.defaultPath, null); assert.deepEqual(cleared.permissionCodes, []); assert.deepEqual(cleared.capabilityKeys, []);
  for (const relation of ['role_versions', 'role_version_permissions', 'role_version_capabilities']) {
    await assert.rejects(owner.query(`DELETE FROM ${relation} WHERE organization_id=$1 AND role_id=$2`, [manager.organizationId, input.id]), { code: '55000' });
  }
  await assert.rejects(owner.query("UPDATE roles SET name='Forged',revision=revision+1 WHERE organization_id=$1 AND id=$2", [manager.organizationId, input.id]), { code: '23514' });
  await assert.rejects(owner.query("INSERT INTO role_permissions(organization_id,role_id,permission_code) VALUES($1,$2,'roles.manage')", [manager.organizationId, input.id]), { code: '23514' });
});

test('revision-zero role edits record actual changes without fabricating creation history or replacing stable identity', async () => {
  const oldRole = randomUUID();
  await owner.query('INSERT INTO roles(organization_id,id,name,description,default_path) VALUES($1,$2,$3,$4,$5)', [manager.organizationId, oldRole, 'Legacy analyst', 'Retained', '/legacy']);
  const edit = command({ id: oldRole, name: 'Edited legacy analyst' });
  await assert.rejects(work((client, identity) => createRole(client, identity, edit)), { code: 'role_exists' });
  const result = await work((client, identity) => updateRole(client, identity, edit)); assert.equal(result.revision, 1);
  const history = await work((client, identity) => loadRole(client, identity, oldRole, { atRevision: 1 }), reader, true);
  assert.equal(history.operation, 'update'); assert.equal(history.previousRevision, 0); assert.equal(history.description, 'Retained'); assert.equal(history.defaultPath, '/legacy');
  assert.deepEqual(await work((client, identity) => updateRole(client, identity, edit)), result);
  assert.equal((await owner.query('SELECT count(*)::int n FROM role_versions WHERE organization_id=$1 AND role_id=$2', [manager.organizationId, oldRole])).rows[0].n, 1);
});

test('concurrent exact retries save once; stale changes and case-insensitive names reject atomically', async () => {
  const input = command();
  const attempts = await Promise.all([0, 1].map(() => work((client, identity) => createRole(client, identity, input))));
  assert.deepEqual(attempts, [{ id: input.id, revision: 1 }, { id: input.id, revision: 1 }]);
  const edits = await Promise.allSettled(['Alpha', 'Beta'].map((name) => work((client, identity) => updateRole(client, identity, { ...input, requestId: randomUUID(), revision: 1, name }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(edits.filter((result) => result.reason?.code === 'stale_role').length, 1);
  const name = `Collision ${randomUUID()}`;
  const collisions = await Promise.allSettled([name, name.toUpperCase()].map((name) => work((client, identity) => createRole(client, identity, command({ name })))));
  assert.equal(collisions.filter((result) => result.status === 'fulfilled').length, 1); assert.equal(collisions.filter((result) => result.reason?.code === 'duplicate_role_name').length, 1);
  await assert.rejects(work((client, identity) => createRole(client, identity, { ...input, name: 'Different retry' })), { code: 'save_request_reused' });
  assert.deepEqual(await work((client, identity) => createRole(client, identity, input), outsider), { id: input.id, revision: 1 },
    'stable role identities are scoped to their organization');
});

test('role reads, historical reads, settings and commands enforce tenant, permission and database boundaries', async () => {
  const input = command(); await work((client, identity) => createRole(client, identity, input));
  for (const atRevision of [undefined, 1]) await assert.rejects(work((client, identity) => loadRole(client, identity, input.id, { atRevision }), outsider, true), { code: 'role_not_found' });
  await assert.rejects(work((client, identity) => updateRole(client, identity, { ...input, requestId: randomUUID(), revision: 1 }), outsider), { code: 'role_not_found' });
  await assert.rejects(work((client, identity) => retireRole(client, identity, { id: input.id, requestId: randomUUID(), revision: 1 }), outsider), { code: 'role_not_found' });
  for (const action of [loadRoleSettings, listRoles]) await assert.rejects(work(action, noAccess, true), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => createRole(client, identity, command()), reader), { code: 'forbidden' });
  await assert.rejects(work((client) => raw(client), reader), { code: '42501', constraint: 'role_session_required' });
  await work(async (client) => {
    assert.equal((await client.query('SELECT * FROM role_versions')).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM role_management_settings')).rowCount, 0);
  }, noAccess, true);
  for (const table of ['roles', 'role_permissions', 'membership_roles', 'role_capabilities', 'role_versions', 'role_version_permissions', 'role_version_capabilities']) {
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_app', table, 'INSERT,UPDATE,DELETE,TRUNCATE'])).rows[0].allowed, false);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', table, 'INSERT,UPDATE,DELETE,TRUNCATE'])).rows[0].allowed, false);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', table, 'SELECT'])).rows[0].allowed, table === 'membership_roles',
      'the pre-existing scoped worker membership read is preserved; no role metadata/history read is added');
  }
  const functions = (await owner.query("SELECT proname,has_function_privilege('sampleify_app',oid,'EXECUTE') AS app,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'roles_%'")).rows;
  assert.equal(functions.length, 8);
  for (const fn of functions) { assert.equal(fn.app, fn.proname === 'roles_write'); assert.equal(fn.worker, false); assert.equal(fn.public, false); }
});

test('role commands validate the actual live session and reject forged or revoked actor context', async () => {
  await assert.rejects(transaction(async (client) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [manager.organizationId, manager.userId]);
    await raw(client);
  }), { code: '42501', constraint: 'role_session_required' });
  await assert.rejects(work(async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [manager.userId]); await raw(client);
  }, reader), { code: '42501', constraint: 'role_session_required' });
  for (const invalidation of ['revoked', 'expired', 'credential', 'inactive_member', 'inactive_user', 'inactive_organization', 'password_change']) {
    const actor = await account({ permissions: ['roles.manage'] });
    await assert.rejects(work(async (client, identity) => {
      if (invalidation === 'revoked') await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      else if (invalidation === 'expired') await owner.query("UPDATE sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1", [actor.userId]);
      else if (invalidation === 'credential') await owner.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [actor.userId]);
      else if (invalidation === 'inactive_member') await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, actor.userId]);
      else if (invalidation === 'inactive_user') await owner.query('UPDATE users SET active=false WHERE id=$1', [actor.userId]);
      else if (invalidation === 'inactive_organization') await owner.query('UPDATE organizations SET active=false WHERE id=$1', [actor.organizationId]);
      else await owner.query('UPDATE users SET must_change_password=true WHERE id=$1', [actor.userId]);
      await createRole(client, identity, command());
    }, actor), { code: 'forbidden' }, invalidation);
  }
});

test('capabilities do not imply API grants, and retired baseline roles disappear from session authority', async () => {
  const actor = await account({ organizationId: manager.organizationId, permissions: [] });
  const input = command({ capabilityKeys: ['can_admin', 'is_creator'], permissionCodes: [] });
  await work((client, identity) => createRole(client, identity, input));
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [manager.organizationId, actor.userId, input.id]);
  await work((_client, identity) => { assert.deepEqual(identity.permission_codes, []); assert.ok(identity.role_names.includes(input.name)); }, actor, true);
  await assert.rejects(work((client, identity) => createRole(client, identity, command()), actor), { code: 'forbidden' });
  const baseline = await account({ permissions: ['roles.manage'] });
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [baseline.organizationId, baseline.roleId]);
  await work(async (client, identity) => {
    assert.deepEqual(identity.permission_codes, []); assert.deepEqual(identity.role_names, []);
    assert.equal((await client.query("SELECT app_has_permission('roles.manage') AS allowed")).rows[0].allowed, false);
  }, baseline, true);
});

test('retirement retains metadata and history, rejects assigned/protected roles and prevents new inactive assignments', async () => {
  const input = command({ description: 'Keep', defaultPath: 'javascript:plain metadata', capabilityKeys: ['can_create_sample'], permissionCodes: ['templates.read'] });
  await work((client, identity) => createRole(client, identity, input));
  const removal = { id: input.id, revision: 1, requestId: randomUUID() };
  assert.deepEqual(await work((client, identity) => retireRole(client, identity, removal)), { id: input.id, revision: 2 });
  assert.deepEqual(await work((client, identity) => retireRole(client, identity, removal)), { id: input.id, revision: 2 });
  const history = await work((client, identity) => loadRole(client, identity, input.id, { atRevision: 2 }), reader, true);
  assert.equal(history.operation, 'retire'); assert.equal(history.active, false); assert.equal(history.defaultPath, input.defaultPath);
  assert.deepEqual(history.capabilityKeys, input.capabilityKeys); assert.deepEqual(history.permissionCodes, input.permissionCodes);
  await assert.rejects(work((client, identity) => loadRole(client, identity, input.id), reader, true), { code: 'role_not_found' });
  assert.equal((await work((client, identity) => customFieldRoles(client, identity, { search: input.name }))).rows.length, 0);
  await assert.rejects(owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [manager.organizationId, reader.userId, input.id]), { constraint: 'role_inactive_assignment' });
  await assert.rejects(work((client, identity) => retireRole(client, identity, { id: reader.roleId, revision: 0, requestId: randomUUID() })), { code: 'role_assigned' });
  const protectedId = randomUUID(); await owner.query('INSERT INTO roles(organization_id,id,name,protected) VALUES($1,$2,$3,true)', [manager.organizationId, protectedId, `System ${protectedId}`]);
  await assert.rejects(work((client, identity) => retireRole(client, identity, { id: protectedId, revision: 0, requestId: randomUUID() })), { code: 'protected_role' });
  await work((client, identity) => updateRole(client, identity, command({ id: protectedId, name: 'System description edit', description: 'Allowed' })));
  assert.equal((await work((client, identity) => loadRole(client, identity, protectedId), reader, true)).protected, true);
});

test('concurrent self-permission removal retains one active administrator and reports successful revocation', async () => {
  const first = await account({ permissions: ['roles.manage'] });
  const second = await account({ organizationId: first.organizationId, permissions: ['roles.manage'] });
  const attempts = await Promise.allSettled([first, second].map((actor) => work((client, identity) => updateRole(client, identity,
    command({ id: actor.roleId, name: `Changed ${actor.roleId}`, permissionCodes: [] })), actor)));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.reason?.code === 'last_role_administrator').length, 1);
  for (const [index, actor] of [first, second].entries()) await work((_client, identity) => {
    assert.equal(identity.permission_codes.includes('roles.manage'), attempts[index].status === 'rejected');
  }, actor, true);
  const remaining = attempts[0].status === 'rejected' ? first : second;
  const inactive = await account({ organizationId: first.organizationId, permissions: ['roles.manage'] });
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [inactive.organizationId, inactive.userId]);
  await assert.rejects(work((client, identity) => updateRole(client, identity, command({ id: remaining.roleId, name: 'Final', permissionCodes: [] })), remaining), { code: 'last_role_administrator' });
});

test('a role command waiting on the organization lock rechecks a revoked manager grant before writing', async () => {
  const actor = await account({ permissions: ['roles.manage'] }); const lock = await owner.connect();
  const input = command(); let pending; let pid;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [actor.organizationId]);
    let signalStarted; const started = new Promise((resolve) => { signalStarted = resolve; });
    pending = work(async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; signalStarted(); return createRole(client, identity, input);
    }, actor).then((result) => ({ result }), (error) => ({ error })).finally(signalStarted);
    // Observe the actual lock wait; even an early authentication failure settles the start signal.
    await started; assert.ok(pid, 'the authenticated callback started');
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'the role command reached the organization lock');
    await lock.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='roles.manage'", [actor.organizationId, actor.roleId]);
    await lock.query('COMMIT'); assert.equal((await pending).error?.code, 'forbidden');
    assert.equal((await owner.query('SELECT count(*)::int n FROM roles WHERE organization_id=$1 AND id=$2', [actor.organizationId, input.id])).rows[0].n, 0);
  } finally { await lock.query('ROLLBACK'); lock.release(); await pending?.catch(() => {}); }
});

test('role lists preserve literal search, source name filters, bounded ordering and historical tenant uniqueness', async () => {
  const special = command({ name: `Literal %_\\' ${randomUUID()}`, description: 'Specific wording', capabilityKeys: ['can_config_datasheets'] });
  await work((client, identity) => createRole(client, identity, special));
  const literal = await work((client, identity) => listRoles(client, identity, { search: "%_\\'" }), reader, true);
  assert.equal(literal.totalCount, 1); assert.equal(literal.rows[0]._id, special.id);
  assert.equal((await work((client, identity) => listRoles(client, identity, { search: 'can_config_datasheets' }), reader, true)).rows[0]._id, special.id);
  const filtered = await work((client, identity) => listRoles(client, identity, { filters: { name: { type: 'text', value: 'Literal' } }, sort: { key: 'name', dir: 'desc' }, pageSize: 1 }), reader, true);
  assert.equal(filtered.rows.length, 1); assert.equal(filtered.rows[0].name, special.name);
  const empty = await work((client, identity) => listRoles(client, identity, { search: special.name, page: 1_000_000 }), reader, true);
  assert.equal(empty.totalCount, 1); assert.deepEqual(empty.rows, []);
  const sameId = { ...special, requestId: randomUUID() }; await work((client, identity) => createRole(client, identity, sameId), outsider);
  assert.equal((await work((client, identity) => loadRole(client, identity, special.id), outsider, true)).name, special.name);
});

test('permission registry, capability and list boundaries reject invalid commands without partial role history', async () => {
  const permissions = Array.from({ length: 500 }, (_, index) => `synthetic.role.${index}`);
  await owner.query('INSERT INTO permissions(code,description) SELECT code,code FROM unnest($1::text[]) code ON CONFLICT DO NOTHING', [permissions]);
  const largest = command({ permissionCodes: permissions, capabilityKeys: roleCapabilityKeys });
  await work((client, identity) => createRole(client, identity, largest));
  const record = await work((client, identity) => loadRole(client, identity, largest.id), reader, true);
  assert.equal(record.permissionCodes.length, 500); assert.equal(record.capabilityKeys.length, 18);
  for (const [change, code] of [[{ permissionCodes: ['unknown.permission'] }, 'invalid_role_permissions'], [{ capabilityKeys: ['can_access_dms'] }, 'invalid_role_keys']]) {
    const input = command(change); await assert.rejects(work((client, identity) => createRole(client, identity, input)), { code });
    assert.equal((await owner.query('SELECT count(*)::int n FROM roles WHERE organization_id=$1 AND id=$2', [manager.organizationId, input.id])).rows[0].n, 0);
  }
  await assert.rejects(work((client) => raw(client, command({ capabilityKeys: ['can_gen_prof_inv'] }))), { code: '23514', constraint: 'role_version_capability_key' });
  await assert.rejects(work((client) => raw(client, command({ permissionCodes: ['templates.read', 'templates.read'] }))), { code: '23514', constraint: 'role_invalid_input' });
  await assert.rejects(work((client, identity) => listRoles(client, identity, { sort: { key: 'name', dir: 'asc; SELECT 1' } }), reader, true), { code: 'invalid_role_sort' });
});

test('actual self-allocation settings govern role visibility and preserve values omitted by earlier clients', async () => {
  assert.deepEqual(await work(loadRoleSettings, reader, true), { selfAllocationEnabled: false });
  const current = await work(loadLaboratorySettings);
  const base = { revision: current.settings.revision, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null };
  const saved = await work((client, identity) => saveLaboratorySettings(client, identity, { ...base, selfAllocationEnabled: true }));
  assert.deepEqual(await work(loadRoleSettings, reader, true), { selfAllocationEnabled: true });
  await assert.rejects(work(loadLaboratorySettings, reader, true), { code: 'forbidden' });
  assert.equal((await work((client) => client.query('SELECT * FROM organization_laboratory_settings'), reader, true)).rowCount, 0);
  const preserved = await work((client, identity) => saveLaboratorySettings(client, identity, { ...base, revision: saved.revision }));
  assert.equal((await work(loadRoleSettings, reader, true)).selfAllocationEnabled, true);
  await assert.rejects(work((client, identity) => saveLaboratorySettings(client, identity, { ...base, revision: preserved.revision, selfAllocationEnabled: 'false' })), { status: 400 });
  await work((client, identity) => saveLaboratorySettings(client, identity, { ...base, revision: preserved.revision, selfAllocationEnabled: false }));
  assert.equal((await work(loadRoleSettings, reader, true)).selfAllocationEnabled, false);
  await assert.rejects(work((client, identity) => saveLaboratorySettings(client, identity, { ...base, selfAllocationEnabled: true })), { code: 'stale_settings' });
});
