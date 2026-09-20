import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, moduleAccessValues, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { loadModuleAccess, moduleAccessOptions } from '../../src/organization-settings/module-access.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { updateRole } from '../../src/roles/service.js';
import { quickCreateCustomer } from '../../src/samples/customer.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const read = actor => work(actor, loadLaboratorySettings, true);
const access = actor => work(actor, async client => (await client.query("SELECT organization_has_module_access('customer') AS customer,organization_has_module_access('vendor') AS vendor")).rows[0], true);
const instrumentAccess = actor => work(actor, async client => (await client.query("SELECT organization_has_module_access('instrument') AS allowed")).rows[0].allowed, true);
const agreementAccess = actor => work(actor, async client => (await client.query("SELECT organization_has_module_access('service_agreements') AS allowed")).rows[0].allowed, true);
const customerInput = () => ({ name: `Module access ${randomUUID()}`, legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
  contactPersonEmail: 'synthetic@example.invalid', contactPersonPhone: '0000', billToAddress: 'Billing\nSecond line', shipToAddress: 'Receiving\nSecond line' });
const createCustomer = actor => work(actor, (client, identity) => quickCreateCustomer(client, identity, customerInput()));
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['settings.manage', 'samples.create', 'users.manage', 'roles.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function configure(actor, change = {}, changes = {}) {
  const modules = emptyModuleAccess(); Object.assign(modules[0], { enabled: true, userIds: [actor.userId] }, change);
  await saveModuleAccessSettings(actor, modules, changes); return modules;
}
async function recordProfile(manager, person, values = {}) {
  const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Synthetic laboratory')", [person.organizationId, lab]);
  return work(manager, (client, identity) => updateUserProfile(client, identity, person.userId,
    { requestId: randomUUID(), revision: 0, defaultRoleId: person.roleId, laboratoryId: lab, ...values }));
}
async function waitForLock(pid, failure) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (failure()) throw failure();
    if (pid() && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid()])).rows[0]?.waiting) return;
    await delay(10);
  }
  assert.fail('Expected module command to wait on a database lock');
}

test('Instrument access requires explicit enabled user or active actual Default Role assignments', async () => {
  const manager = await account(); const person = await account({ organizationId: manager.organizationId }); const foreign = await account();
  const modules = emptyModuleAccess(); const instrument = modules[2];
  assert.equal(await instrumentAccess(person), false);
  instrument.enabled = true; await saveModuleAccessSettings(manager, modules); assert.equal(await instrumentAccess(person), false);
  instrument.roleIds = [person.roleId]; await saveModuleAccessSettings(manager, modules); assert.equal(await instrumentAccess(person), false);
  await recordProfile(manager, person); assert.equal(await instrumentAccess(person), true);
  await work(manager, (client, identity) => updateUserProfile(client, identity, person.userId,
    { requestId: randomUUID(), revision: 1, roleIds: [person.roleId, manager.roleId] }));
  instrument.roleIds = [manager.roleId]; await saveModuleAccessSettings(manager, modules); assert.equal(await instrumentAccess(person), false);
  instrument.roleIds = [person.roleId]; await saveModuleAccessSettings(manager, modules);
  // Imported inactive roles remain possible even though authoring cannot retire an assigned role.
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [person.organizationId, person.roleId]);
  assert.equal(await instrumentAccess(person), false);
  instrument.userIds = [person.userId]; await saveModuleAccessSettings(manager, modules); assert.equal(await instrumentAccess(person), true);
  instrument.enabled = false; await saveModuleAccessSettings(manager, modules); assert.equal(await instrumentAccess(person), false);
  instrument.enabled = true; instrument.userIds = [foreign.userId];
  await assert.rejects(saveModuleAccessSettings(manager, modules), { code: 'invalid_module_access_reference' });
  assert.equal(await instrumentAccess(foreign), false);
  await work(manager, async client => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [person.userId]);
    assert.equal((await client.query("SELECT organization_has_module_access('instrument') AS allowed")).rows[0].allowed, false);
  });
});

test('older two-module clients preserve Instrument grants; explicit clears retain immutable history', async () => {
  const actor = await account(); const other = await account({ organizationId: actor.organizationId });
  const modules = emptyModuleAccess(); modules[2] = { moduleKey: 'instrument', enabled: true, roleIds: [other.roleId, actor.roleId], userIds: [other.userId, actor.userId] };
  await saveModuleAccessSettings(actor, modules);
  const historical = await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true);
  assert.equal(historical.moduleCount, 5); assert.equal(await instrumentAccess(actor), true);
  const legacy = modules.slice(0, 2); legacy[0] = { ...legacy[0], enabled: true, userIds: [actor.userId] };
  await saveModuleAccessSettings(actor, legacy);
  assert.deepEqual(moduleAccessValues((await read(actor)).settings.moduleAccess), [...legacy, ...modules.slice(2)]);
  assert.equal(await instrumentAccess(actor), true);
  await work(actor, (client, identity) => saveLaboratorySettings(client, identity, { revision: 2, autoCreateJobs: false, dateFormat: 'YYYY-MM-DD' }));
  assert.equal((await read(actor)).settings.moduleAccessRevision, 2);
  await saveModuleAccessSettings(actor, emptyModuleAccess()); assert.equal(await instrumentAccess(actor), false);
  await saveModuleAccessSettings(actor, legacy); assert.equal(await instrumentAccess(actor), false);
  assert.deepEqual(await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true), historical);
  const history = (await owner.query('SELECT revision,module_count FROM organization_module_access_versions WHERE organization_id=$1 ORDER BY revision', [actor.organizationId])).rows;
  assert.deepEqual(history, [1, 2, 4, 5].map(revision => ({ revision, module_count: 5 })));
});

test('an older two-module initial save creates a disabled unassigned Instrument row', async () => {
  const actor = await account(); await saveModuleAccessSettings(actor, emptyModuleAccess().slice(0, 2));
  const saved = await work(actor, (client, identity) => loadModuleAccess(client, identity), true);
  assert.equal(saved.moduleCount, 5); assert.deepEqual(moduleAccessValues(saved.modules), emptyModuleAccess());
  assert.equal(await instrumentAccess(actor), false);
  const reader = await account({ organizationId: actor.organizationId, permissions: ['settings.read'] });
  await assert.rejects(saveModuleAccessSettings(reader, emptyModuleAccess()), { status: 403 });
});

test('Service Agreement access uses explicit users or the actual active Default Role without cross-module grants', async () => {
  const manager = await account(); const person = await account({ organizationId: manager.organizationId }); const foreign = await account();
  const modules = emptyModuleAccess(); const agreement = modules[3];
  assert.equal(await agreementAccess(person), false);
  agreement.enabled = true; await saveModuleAccessSettings(manager, modules); assert.equal(await agreementAccess(person), false);
  agreement.roleIds = [person.roleId]; await saveModuleAccessSettings(manager, modules); assert.equal(await agreementAccess(person), false);
  await recordProfile(manager, person); assert.equal(await agreementAccess(person), true);
  assert.equal(await instrumentAccess(person), false); assert.deepEqual(await access(person), { customer: false, vendor: false });
  await work(manager, (client, identity) => updateUserProfile(client, identity, person.userId,
    { requestId: randomUUID(), revision: 1, roleIds: [person.roleId, manager.roleId] }));
  agreement.roleIds = [manager.roleId]; await saveModuleAccessSettings(manager, modules); assert.equal(await agreementAccess(person), false);
  agreement.roleIds = [person.roleId]; await saveModuleAccessSettings(manager, modules);
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [person.organizationId, person.roleId]);
  assert.equal(await agreementAccess(person), false);
  agreement.userIds = [person.userId]; await saveModuleAccessSettings(manager, modules); assert.equal(await agreementAccess(person), true);
  agreement.enabled = false; await saveModuleAccessSettings(manager, modules); assert.equal(await agreementAccess(person), false);
  agreement.enabled = true; agreement.userIds = [foreign.userId];
  await assert.rejects(saveModuleAccessSettings(manager, modules), { code: 'invalid_module_access_reference' });
  await work(manager, async client => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [person.userId]);
    assert.equal((await client.query("SELECT organization_has_module_access('service_agreements') AS allowed")).rows[0].allowed, false);
  });
  assert.equal(await agreementAccess(foreign), false);
});

test('two- and three-module callers preserve Service Agreement assignments; explicit clears remain cleared', async () => {
  const actor = await account(); const other = await account({ organizationId: actor.organizationId });
  const modules = emptyModuleAccess();
  for (const entry of modules.slice(2)) Object.assign(entry, { enabled: true, roleIds: [other.roleId, actor.roleId], userIds: [other.userId, actor.userId] });
  await saveModuleAccessSettings(actor, modules);
  const original = await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true);
  for (const count of [3, 2]) {
    const legacy = structuredClone(modules.slice(0, count)); legacy[0].enabled = true; legacy[0].userIds = [actor.userId];
    await saveModuleAccessSettings(actor, legacy);
    assert.deepEqual(moduleAccessValues((await read(actor)).settings.moduleAccess), [...legacy, ...modules.slice(count)]);
    assert.equal(await agreementAccess(actor), true); assert.equal(await instrumentAccess(actor), true);
  }
  const cleared = structuredClone(modules); cleared[3] = emptyModuleAccess()[3];
  await saveModuleAccessSettings(actor, cleared); assert.equal(await agreementAccess(actor), false);
  await saveModuleAccessSettings(actor, modules.slice(0, 3)); assert.equal(await agreementAccess(actor), false);
  assert.deepEqual(await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true), original);
  const fresh = await account(); await saveModuleAccessSettings(fresh, modules.slice(0, 2));
  assert.deepEqual(moduleAccessValues((await read(fresh)).settings.moduleAccess).slice(2), emptyModuleAccess().slice(2));
});

test('absent, disabled and empty configuration denies authoring without creating inferred grants', async () => {
  const actor = await account(); const initial = await read(actor);
  assert.equal(initial.settings.moduleAccessRevision, 0); assert.deepEqual(moduleAccessValues(initial.settings.moduleAccess), emptyModuleAccess());
  assert.deepEqual(await access(actor), { customer: false, vendor: false });
  assert.equal((await work(actor, sampleRegistrationOptions, true)).canQuickCreateCustomer, false);
  await assert.rejects(createCustomer(actor), { status: 403, code: 'customer_module_access_required' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM organization_module_access_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
  await configure(actor, { enabled: false }); await assert.rejects(createCustomer(actor), { status: 403 });
  await configure(actor, { userIds: [] }); await assert.rejects(createCustomer(actor), { status: 403 });
  await configure(actor); assert.equal((await work(actor, sampleRegistrationOptions, true)).canQuickCreateCustomer, true);
  const customer = await createCustomer(actor); assert.equal(customer.addresses.length, 2);
  await configure(actor, { enabled: false });
  assert((await work(actor, sampleRegistrationOptions, true)).customers.some(row => row.id === customer.id));
});

test('only a configured Default Role or explicit user grants access; action permissions remain required', async () => {
  const manager = await account(); const person = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  const modules = emptyModuleAccess(); modules[0] = { moduleKey: 'customer', enabled: true, roleIds: [person.roleId], userIds: [] };
  await saveModuleAccessSettings(manager, modules);
  assert.equal((await access(person)).customer, false); assert.equal((await access(manager)).customer, false);
  await recordProfile(manager, person); assert.equal((await access(person)).customer, true); await createCustomer(person);
  await work(manager, (client, identity) => updateUserProfile(client, identity, person.userId,
    { requestId: randomUUID(), revision: 1, roleIds: [person.roleId, manager.roleId] }));
  modules[0].roleIds = [manager.roleId]; await saveModuleAccessSettings(manager, modules); assert.equal((await access(person)).customer, false);
  modules[0].userIds = [person.userId, manager.userId]; await saveModuleAccessSettings(manager, modules); assert.equal((await access(person)).customer, true);
  const reader = await account({ organizationId: manager.organizationId, permissions: ['settings.read'] });
  modules[0].userIds.push(reader.userId); await saveModuleAccessSettings(manager, modules);
  assert.equal((await access(reader)).customer, true); await assert.rejects(createCustomer(reader), { status: 403 });
  await assert.rejects(work(reader, client => client.query('SELECT laboratory_quick_customer($1,$2,$3,$4,$5,$6,$7)', Object.values(customerInput()))), { code: '42501' });
  await assert.rejects(saveModuleAccessSettings(reader, modules), { status: 403 });
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [person.organizationId, person.roleId]);
  modules[0].userIds = []; modules[0].roleIds = [person.roleId]; await saveModuleAccessSettings(manager, modules);
  assert.equal((await access(person)).customer, false);
});

test('ordered assignments and observed labels survive rename, inactivity, omitted edits and stale or foreign saves', async () => {
  const actor = await account(); const other = await account({ organizationId: actor.organizationId }); const foreign = await account();
  const modules = await configure(actor, { roleIds: [other.roleId, actor.roleId], userIds: [other.userId, actor.userId] }, { dateFormat: 'DD/MM/YYYY' });
  const historical = await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true);
  assert.equal(historical.savedBy, actor.userId); assert(historical.savedAt instanceof Date); assert.deepEqual(moduleAccessValues(historical.modules), modules);
  await owner.query("UPDATE roles SET name='Later role',active=false WHERE organization_id=$1 AND id=$2", [actor.organizationId, other.roleId]);
  await owner.query("UPDATE users SET display_name='Later user',revision=revision+1 WHERE id=$1", [other.userId]);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, other.userId]);
  const current = (await read(actor)).settings; assert.equal(current.moduleAccess[0].roles[0].name, 'Later role'); assert.equal(current.moduleAccess[0].roles[0].active, false);
  assert.equal(current.moduleAccess[0].users[0].name, 'Later user'); assert.equal(current.moduleAccess[0].users[0].active, false);
  await work(actor, (client, identity) => saveLaboratorySettings(client, identity, { revision: 1, autoCreateJobs: false, dateFormat: 'YYYY-MM-DD' }));
  assert.equal((await read(actor)).settings.moduleAccessRevision, 1);
  assert.deepEqual(await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 2 }), true), historical);
  const bad = structuredClone(modules); bad[0].userIds.push(foreign.userId);
  await assert.rejects(saveModuleAccessSettings(actor, bad, { autoCreateJobs: true, dateFormat: 'DD-MM-YYYY' }), { status: 400, code: 'invalid_module_access_reference' });
  await assert.rejects(saveModuleAccessSettings(actor, modules, { revision: 1 }), { status: 409, code: 'stale_settings' });
  const preserved = (await read(actor)).settings; assert.equal(preserved.revision, 2); assert.equal(preserved.autoCreateJobs, false); assert.equal(preserved.dateFormat, 'YYYY-MM-DD');
  await saveModuleAccessSettings(actor, modules); assert.equal((await read(actor)).settings.moduleAccessRevision, 3);
  assert.deepEqual(await work(actor, (client, identity) => loadModuleAccess(client, identity, { atRevision: 1 }), true), historical);
});

test('scoped catalogs paginate exact IDs and source accent searches, including retained inactive references', async () => {
  const actor = await account(); const foreign = await account(); const person = await account({ organizationId: actor.organizationId });
  const ids = Array.from({ length: 220 }, () => randomUUID());
  await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,id,'Catalog '||lpad(position::text,3,'0') FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)", [actor.organizationId, ids]);
  await owner.query("UPDATE roles SET name='Étalon Prüfgerät',active=false WHERE organization_id=$1 AND id=$2", [actor.organizationId, ids[219]]);
  await owner.query("UPDATE users SET display_name='Zoë Référence',revision=revision+1 WHERE id=$1", [person.userId]);
  const options = input => work(actor, (client, identity) => moduleAccessOptions(client, identity, input), true);
  const first = await options({ kind: 'role', search: 'catalog' }); const second = await options({ kind: 'role', search: 'catalog', page: 2 }); const third = await options({ kind: 'role', search: 'catalog', page: 3 });
  assert.equal(first.rows.length, 100); assert.equal(second.rows.length, 100); assert.equal(third.rows.length, 19); assert.equal(third.hasMore, false);
  assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size, 219);
  const accent = await options({ kind: 'role', search: 'etalon prufgerat' }); assert.deepEqual(accent.rows.map(row => row.id), [ids[219]]); assert.equal(accent.rows[0].active, false);
  assert.deepEqual((await options({ kind: 'role', search: ids[150].toUpperCase() })).rows.map(row => row.id), [ids[150]]);
  assert.deepEqual((await options({ kind: 'user', search: 'Zoe Reference' })).rows.map(row => row.id), [person.userId]);
  assert.equal((await options({ kind: 'user', search: foreign.userId })).rows.length, 0);
  assert.deepEqual((await options({ kind: 'role', page: 1_000_000 })).rows, []);
  for (const input of [{ kind: 'invalid' }, { kind: 'user', page: 0 }, { kind: 'user', search: '\0' }, { kind: 'user', search: 'x'.repeat(501) }]) {
    await assert.rejects(options(input), { status: 400 });
  }
  const denied = await account({ organizationId: actor.organizationId, permissions: ['samples.create'] });
  await assert.rejects(work(denied, (client, identity) => moduleAccessOptions(client, identity, { kind: 'role' }), true), { status: 403 });
  assert.equal((await work(denied, client => client.query('SELECT * FROM organization_module_user_catalog'), true)).rowCount, 0);
});

test('catalog searches retain the lookahead across a scan boundary and paginate late matches', async () => {
  const actor = await account(); const ids = Array.from({ length: 1002 }, () => randomUUID());
  await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,id,'Catalog '||lpad(position::text,4,'0') FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)", [actor.organizationId, ids]);
  const options = input => work(actor, (client, identity) => moduleAccessOptions(client, identity, { kind: 'role', ...input }), true);
  const penultimate = await options({ search: 'catalog', page: 10 }); const last = await options({ search: 'catalog', page: 11 });
  assert.deepEqual(penultimate.rows.map(row => row.id), ids.slice(900, 1000)); assert.equal(penultimate.hasMore, true);
  assert.deepEqual(last.rows.map(row => row.id), ids.slice(1000)); assert.equal(last.hasMore, false);
  assert.deepEqual((await options({ search: ids[1000].toUpperCase() })).rows.map(row => row.id), [ids[1000]]);
  assert.deepEqual((await options({ search: 'catalog', page: 12 })).rows, []);
});

test('history is immutable, tenant scoped and unavailable to direct application writes or the worker', async () => {
  const actor = await account(); const foreign = await account(); await configure(actor, { roleIds: [actor.roleId] });
  for (const table of ['organization_module_access_versions', 'organization_module_access_modules', 'organization_module_access_roles', 'organization_module_access_users']) {
    assert.equal((await work(foreign, client => client.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), true)).rowCount, 0);
    await assert.rejects(work(actor, client => client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [actor.organizationId])), { code: '42501' });
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), { code: '55000' });
    const privileges = (await owner.query("SELECT has_table_privilege('sampleify_report_worker',$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed", [table])).rows[0]; assert.equal(privileges.allowed, false);
  }
  const permissions = (await owner.query(`SELECT proname,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
    FROM pg_proc WHERE proname IN ('organization_module_scope','organization_has_module_access','organization_require_module_access','organization_save_module_access')`)).rows;
  assert.equal(permissions.length, 4); assert(permissions.every(row => !row.worker && !row.public));
  for (const [key, value] of [['app.user_id', foreign.userId], ['app.organization_id', foreign.organizationId], ['app.session_id', randomUUID()]]) {
    await assert.rejects(work(actor, async client => { await client.query('SELECT set_config($1,$2,true)', [key, value]); await client.query("SELECT organization_require_module_access('customer')"); }),
      { code: '42501', constraint: 'organization_module_access_required' });
  }
});

test('raw module commands reject malformed arrays and require the same transaction settings revision', async () => {
  const actor = await account(); await configure(actor);
  const raw = (client, args) => client.query('SELECT organization_save_module_access($1,$2::text[],$3::boolean[],$4::text[],$5::uuid[],$6::text[],$7::uuid[])', args);
  await assert.rejects(work(actor, client => raw(client, [1, ['customer', 'vendor'], [true, false], [], [], [], []])), { code: '23514', constraint: 'module_access_current_settings' });
  for (const arrays of [
    [['vendor', 'customer'], [true, false], [], [], [], []], [['customer', 'vendor'], [true, null], [], [], [], []],
    [['customer', 'vendor'], [true, false], ['customer'], [], [], []], [['customer', 'vendor'], [true, false], [], [], ['bad'], [actor.userId]],
    [['customer', 'vendor'], [true, false], ['customer'], [null], [], []], [['customer', 'vendor'], [true, false], [], [], null, null],
  ]) {
    await assert.rejects(work(actor, async (client, identity) => {
      await saveLaboratorySettings(client, identity, { revision: 1, autoCreateJobs: true }); await raw(client, [2, ...arrays]);
    }), { code: '23514', constraint: 'module_access_input' });
    assert.equal((await read(actor)).settings.revision, 1);
  }
});

test('deferred checks reject missing, extra and gapped selections while permitting complete empty sets', async () => {
  const actor = await account(); await configure(actor);
  const cases = [{ headers: 0 }, { headers: 1 }, { headers: 2, count: 1 }, { headers: 2, count: 0, position: 0 },
    { headers: 2, count: 1, position: 1 }, { headers: 2, count: 0, valid: true }, { headers: 2, count: 1, position: 0, valid: true },
    { headers: 2, moduleCount: 3 }, { headers: 3, moduleCount: 2 }, { headers: 3, moduleCount: 3, valid: true },
    { headers: 3, moduleCount: 3, count: 1, position: 0, valid: true }, { headers: 3, moduleCount: 4 },
    { headers: 4, moduleCount: 3 }, { headers: 4, moduleCount: 4, valid: true },
    { headers: 4, moduleCount: 4, count: 1, position: 0, valid: true }];
  for (const item of cases) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO organization_module_access_versions(organization_id,revision,saved_by,module_count) VALUES($1,999,$2,$3)', [actor.organizationId, actor.userId, item.moduleCount ?? 2]);
      for (const key of ['customer', 'vendor', 'instrument', 'service_agreements'].slice(0, item.headers)) {
        await client.query('INSERT INTO organization_module_access_modules(organization_id,revision,module_key,enabled,role_count,user_count) VALUES($1,999,$2,true,$3,0)', [actor.organizationId, key, key === 'customer' ? item.count ?? 0 : 0]);
      }
      if (item.position !== undefined) await client.query("INSERT INTO organization_module_access_roles(organization_id,revision,module_key,role_id,position,role_name,role_active) VALUES($1,999,'customer',$2,$3,'Synthetic',true)", [actor.organizationId, actor.roleId, item.position]);
      const check = () => client.query('SET CONSTRAINTS module_access_complete IMMEDIATE');
      if (item.valid) await assert.doesNotReject(check); else await assert.rejects(check, { code: '23514', constraint: 'module_access_complete' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
});

test('quick customer waits for actual settings, profile and role writers then rechecks their committed revocations', { timeout: 30000 }, async () => {
  for (const kind of ['settings', 'profile', 'role']) {
    const manager = await account(); const person = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
    await recordProfile(manager, person, kind === 'profile' ? { roleIds: [person.roleId, manager.roleId] } : {});
    const modules = emptyModuleAccess(); modules[0] = { moduleKey: 'customer', enabled: true, roleIds: [person.roleId], userIds: [] };
    await saveModuleAccessSettings(manager, modules); await createCustomer(person);
    let releaseEditor; const gate = new Promise(resolve => { releaseEditor = resolve; }); let changed;
    const ready = new Promise(resolve => { changed = resolve; }); let editorFailure;
    const editing = work(manager, async (client, identity) => {
      if (kind === 'settings') await saveLaboratorySettings(client, identity, { revision: 1, autoCreateJobs: false, moduleAccess: emptyModuleAccess() });
      else if (kind === 'profile') await updateUserProfile(client, identity, person.userId, { requestId: randomUUID(), revision: 1, defaultRoleId: manager.roleId });
      else await updateRole(client, identity, { id: person.roleId, requestId: randomUUID(), revision: 0, name: `Reader ${person.roleId}`, permissionCodes: [] });
      changed(); await gate;
    });
    void editing.catch(error => { editorFailure = error; }); let pending; let failure; let pid;
    try {
      await Promise.race([ready, editing.then(() => { throw new Error('Expected native editor to reach transaction gate'); })]);
      pending = work(person, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return quickCreateCustomer(client, identity, customerInput()); });
      void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure ?? editorFailure); releaseEditor(); await editing;
      await assert.rejects(pending, { status: 403 });
      assert.equal((await owner.query('SELECT count(*)::integer AS count FROM customers WHERE organization_id=$1', [manager.organizationId])).rows[0].count, 1);
    } finally { releaseEditor(); await editing.catch(() => {}); if (pending) await pending.catch(() => {}); }
  }
});

test('live session, membership, user, organization and credential revocations are rechecked after a lock wait', { timeout: 30000 }, async () => {
  for (const kind of ['session', 'membership', 'user', 'organization', 'credential', 'expiry']) {
    const actor = await account(); await configure(actor); const blocker = await owner.connect(); let pending; let failure; let pid;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.userId]);
      if (kind === 'expiry') await blocker.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE user_id=$1", [actor.userId]);
      pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; return quickCreateCustomer(client, identity, customerInput()); });
      void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure);
      if (kind === 'session') await blocker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [actor.userId]);
      if (kind === 'membership') await blocker.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [actor.organizationId, actor.userId]);
      if (kind === 'user') await blocker.query('UPDATE users SET must_change_password=true WHERE id=$1', [actor.userId]);
      if (kind === 'organization') await blocker.query('UPDATE organizations SET active=false WHERE id=$1', [actor.organizationId]);
      if (kind === 'credential') await blocker.query('UPDATE credentials SET revision=revision+1 WHERE user_id=$1', [actor.userId]);
      if (kind === 'expiry') await delay(750);
      await blocker.query('COMMIT'); await assert.rejects(pending, { status: 403 });
      assert.equal((await owner.query('SELECT count(*)::integer AS count FROM customers WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  }
});

test('a settings read keeps the module revision belonging to its observed settings head during a concurrent save', async () => {
  for (const initial of [false, true]) {
    const actor = await account(); const manager = await account({ organizationId: actor.organizationId });
    if (initial) await configure(actor);
    let calls = 0;
    const result = await work(actor, (client, identity) => loadLaboratorySettings({ async query(...args) {
      const value = await client.query(...args);
      if (++calls === 1) await saveModuleAccessSettings(manager, emptyModuleAccess());
      return value;
    } }, identity));
    assert.equal(result.settings.revision, initial ? 1 : 0);
    assert.equal(result.settings.moduleAccessRevision, initial ? 1 : 0);
    assert.equal(result.settings.moduleAccess[0].enabled, initial);
    assert.equal((await read(actor)).settings.moduleAccess[0].enabled, false);
  }
});

test('module settings save returns forbidden after an actual role writer revokes settings permission', { timeout: 15000 }, async () => {
  const manager = await account(); const actor = await account({ organizationId: manager.organizationId, permissions: ['settings.manage'] });
  let releaseEditor; const gate = new Promise(resolve => { releaseEditor = resolve; }); let changed;
  const ready = new Promise(resolve => { changed = resolve; }); let editorFailure;
  const editing = work(manager, async (client, identity) => {
    await updateRole(client, identity, { id: actor.roleId, requestId: randomUUID(), revision: 0, name: `Reader ${actor.roleId}`, permissionCodes: [] });
    changed(); await gate;
  });
  void editing.catch(error => { editorFailure = error; }); let pending; let failure; let pid;
  try {
    await Promise.race([ready, editing.then(() => { throw new Error('Expected role writer transaction gate'); })]);
    pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return saveLaboratorySettings(client, identity, { revision: 0, autoCreateJobs: false, moduleAccess: emptyModuleAccess() }); });
    void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure ?? editorFailure); releaseEditor(); await editing;
    await assert.rejects(pending, { status: 403, code: 'forbidden' });
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM organization_module_access_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
  } finally { releaseEditor(); await editing.catch(() => {}); if (pending) await pending.catch(() => {}); }
});
