import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadInstrumentCore, saveInstrumentCore, retireInstrumentCore } from '../../src/instruments/core.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { createWorkflowMaster, retireWorkflowMaster } from '../../src/workflows/metadata.js';
import { updateRole } from '../../src/roles/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['instruments.manage', 'settings.manage', 'workflows.manage', 'templates.manage', 'roles.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const actor = await account(); const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'INST-LAB','Instrument laboratory')", [actor.organizationId, laboratoryId]);
  const modules = emptyModuleAccess(); modules[2] = { ...modules[2], enabled: true, userIds: [actor.userId] };
  const services = [{ id: randomUUID(), serviceCode: 'inspection', displayLabel: 'Inspection', isActive: true },
    { id: randomUUID(), serviceCode: 'calibration', displayLabel: 'Calibration', isActive: true }];
  await saveModuleAccessSettings(actor, modules, { instrumentServiceTypes: services });
  return { actor, laboratoryId, modules, services };
}
const input = (context, changes) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Synthetic Instrument', code: 'Inst-' + randomUUID(),
  laboratoryId: context.laboratoryId, dateOfInstallation: '2026-09-17', allowedUserIds: [context.actor.userId], ...changes });
const save = (actor, value) => work(actor, (client, identity) => saveInstrumentCore(client, identity, value));
const load = (actor, id, options) => work(actor, (client, identity) => loadInstrumentCore(client, identity, id, options), true);
const retire = (actor, record, requestId = randomUUID()) => work(actor, (client, identity) => retireInstrumentCore(client, identity, { id: record.id, revision: record.revision, requestId }));
async function serviceReferences(actor) {
  const template = await work(actor, (client, identity) => createTemplate(client, identity, { name: 'Instrument service', kind: 'equipment_service_log' }));
  const workflow = await work(actor, (client, identity) => createWorkflowMaster(client, identity,
    { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: 'Instrument service ' + randomUUID(), appliesTo: 'instrument_service' }));
  return { template, workflow };
}
async function waitForLock(pid, failure = () => null) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (failure()) throw failure();
    if (pid() && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid()])).rows[0]?.waiting) return;
    await delay(10);
  }
  assert.fail('Expected the Instrument operation to wait on a database lock');
}

test('Instrument service retains hidden metadata, decimal precision, zero and inactive status through partial edits and retries', async () => {
  const context = await fixture(); const original = input(context, { calibrated: false, active: false, costOfEquipment: '0', manufacturerSupplier: 'Supplier', currentLocation: 'Shelf' });
  const saved = await save(context.actor, original); assert.equal(saved.costOfEquipment, '0.00'); assert.equal(saved.calibrated, false); assert.equal(saved.active, false);
  const partial = { id: saved.id, revision: 1, requestId: randomUUID(), name: 'Renamed' };
  const edited = await save(context.actor, partial); assert.equal(edited.currentLocation, 'Shelf'); assert.equal(edited.manufacturerSupplier, 'Supplier');
  assert.equal(edited.active, false); assert.equal(edited.status, 'retired'); assert.equal(edited.retired, false);
  await save(context.actor, { id: saved.id, revision: 2, requestId: randomUUID(), costOfEquipment: '9999999999999999.99', active: true });
  assert.deepEqual(await save(context.actor, partial), edited); assert.deepEqual(await save(context.actor, original), saved);
  assert.deepEqual(await load(context.actor, saved.id, { atRevision: 1 }), saved);
  await assert.rejects(save(context.actor, { ...partial, requestId: randomUUID() }), { code: 'stale_instrument' });
  await assert.rejects(save(context.actor, { ...partial, name: 'Different retry' }), { code: 'save_request_reused' });
  await assert.rejects(save(context.actor, input(context, { costOfEquipment: '10000000000000000' })), { code: 'invalid_instrument_number' });
  await assert.rejects(save(context.actor, input(context, { costOfEquipment: '-0.001' })), { code: 'invalid_instrument_cost' });
});

test('Instrument keys retain source case and retirement preserves code identity and history', async () => {
  const context = await fixture(); const code = 'Case-' + randomUUID();
  const first = await save(context.actor, input(context, { code }));
  await save(context.actor, input(context, { code: code.toUpperCase() }));
  await assert.rejects(save(context.actor, input(context, { code })), { code: 'duplicate_instrument_code' });
  const requestId = randomUUID(); const removed = await retire(context.actor, first, requestId);
  assert.deepEqual(await retire(context.actor, first, requestId), removed);
  await assert.rejects(load(context.actor, first.id), { code: 'instrument_not_found' });
  assert.equal((await load(context.actor, first.id, { atRevision: 1 })).retired, false);
  assert.equal((await load(context.actor, first.id, { atRevision: 2 })).retired, true);
  await assert.rejects(save(context.actor, input(context, { code })), { code: 'duplicate_instrument_code' });
});

test('Instrument snapshots preserve service IDs, order, roles and labels when definitions change or settings are omitted', async () => {
  const context = await fixture(); const { actor } = context; const references = await serviceReferences(actor);
  const another = await account({ organizationId: actor.organizationId, permissions: [] });
  const configurations = ['inspection', 'calibration'].map(serviceCode => ({ id: randomUUID(), serviceCode, templateId: references.template.templateId,
    workflowId: references.workflow.workflowId, reminderRoleIds: [another.roleId, actor.roleId], frequencyDays: 30, reminderBeforeDays: 0 }));
  const saved = await save(actor, input(context, { allowedUserIds: [another.userId, actor.userId], serviceConfigurations: configurations }));
  assert.deepEqual(saved.allowedUserIds, [another.userId, actor.userId]); assert.deepEqual(saved.serviceConfigurations[0].reminderRoleIds, [another.roleId, actor.roleId]);
  await saveModuleAccessSettings(actor, context.modules, { instrumentServiceTypes: [{ ...context.services[0], displayLabel: 'Changed inspection', isActive: false }, context.services[1]] });
  const edited = await save(actor, { id: saved.id, revision: 1, requestId: randomUUID(), name: 'Updated' });
  assert.deepEqual(edited.serviceConfigurations, saved.serviceConfigurations); assert.deepEqual(edited.allowedUsers, saved.allowedUsers);
  await assert.rejects(save(actor, { id: saved.id, revision: 2, requestId: randomUUID(), serviceConfigurations: configurations }), { code: 'invalid_instrument_service_reference' });
  const removed = await save(actor, { id: saved.id, revision: 2, requestId: randomUUID(), serviceConfigurations: [{ ...configurations[1], frequencyDays: 45 }] });
  assert.equal(removed.serviceConfigurations.length, 1); assert.equal(removed.serviceConfigurations[0].id, configurations[1].id);
  assert.deepEqual((await load(actor, saved.id, { atRevision: 1 })).serviceConfigurations, saved.serviceConfigurations);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM instrument_version_services WHERE organization_id=$1 AND instrument_id=$2', [actor.organizationId, saved.id])).rows[0].count, 5);
});

test('Instrument record and purchase-file reads require configured module, operation and current record access', async () => {
  const context = await fixture(); const { actor } = context;
  const reader = await account({ organizationId: actor.organizationId, permissions: ['instruments.read'] });
  const denied = await account({ organizationId: actor.organizationId, permissions: ['instruments.read'] });
  const foreign = await account({ permissions: ['instruments.read'] });
  context.modules[2].userIds.push(reader.userId, denied.userId); await saveModuleAccessSettings(actor, context.modules);
  const file = randomUUID(); const content = Buffer.from('Synthetic instrument purchase file');
  await work(actor, client => client.query('SELECT instruments_upload_file($1,$2,$3,$4)', [file, 'purchase.txt', 'text/plain', content]));
  const record = await save(actor, input(context, { purchaseFileId: file, allowedUserIds: [reader.userId] }));
  assert.equal((await load(reader, record.id)).name, record.name);
  await assert.rejects(load(denied, record.id), { code: 'instrument_not_found' });
  await assert.rejects(load(foreign, record.id), { code: 'instrument_module_access_required' });
  const readFile = person => work(person, client => client.query('SELECT content FROM instrument_files WHERE id=$1', [file]), true);
  assert.deepEqual((await readFile(reader)).rows[0].content, content); assert.equal((await readFile(denied)).rowCount, 0);
  await assert.rejects(save(reader, input(context)), { status: 403 });
  await work(actor, (client, identity) => updateRole(client, identity, { id: denied.roleId, revision: 0, requestId: randomUUID(), name: 'All instruments', capabilityKeys: ['can_access_instruments_all'] }));
  assert.equal((await load(denied, record.id)).id, record.id);
  await work(actor, (client, identity) => updateRole(client, identity, { id: denied.roleId, revision: 1, requestId: randomUUID(), name: 'All instruments', capabilityKeys: [] }));
  await assert.rejects(load(denied, record.id), { code: 'instrument_not_found' });
  await save(actor, { id: record.id, revision: 1, requestId: randomUUID(), allowedUserIds: [actor.userId] });
  await assert.rejects(load(reader, record.id, { atRevision: 1 }), { code: 'instrument_not_found' }); assert.equal((await readFile(reader)).rowCount, 0);
  context.modules[2].enabled = false; await saveModuleAccessSettings(actor, context.modules);
  await assert.rejects(load(actor, record.id), { code: 'instrument_module_access_required' });
  await assert.rejects(retire(actor, { ...record, revision: 2 }), { code: 'instrument_module_access_required' });
});

test('Instrument writes reject foreign references, forged context and direct head/history writes', async () => {
  const context = await fixture(); const foreign = await fixture(); const record = await save(context.actor, input(context));
  await assert.rejects(save(context.actor, input(context, { laboratoryId: foreign.laboratoryId })), { code: 'invalid_instrument_reference' });
  await assert.rejects(save(context.actor, input(context, { allowedUserIds: [foreign.actor.userId] })), { code: 'invalid_instrument_reference' });
  await assert.rejects(work(context.actor, async client => { await client.query("SELECT set_config('app.user_id',$1,true)", [foreign.actor.userId]); await client.query('SELECT instruments_require_writer()'); }), { code: '42501' });
  for (const table of ['instruments', 'instrument_versions', 'instrument_version_users', 'instrument_version_services', 'instrument_version_service_roles', 'instrument_files']) {
    await assert.rejects(work(context.actor, client => client.query(`DELETE FROM ${table}`)), { code: '42501' });
  }
  assert.equal((await load(context.actor, record.id)).revision, 1);
});

test('the native readable Instrument set preserves current access to inactive and retired history and rechecks revocation', async () => {
  const context = await fixture(); const { actor } = context;
  const reader = await account({ organizationId: actor.organizationId, permissions: ['instruments.read'] });
  const denied = await account({ organizationId: actor.organizationId, permissions: ['instruments.read'] });
  const foreign = await fixture();
  context.modules[2].userIds.push(reader.userId, denied.userId); await saveModuleAccessSettings(actor, context.modules);
  const allowed = await save(actor, input(context, { allowedUserIds: [reader.userId] }));
  const hidden = await save(actor, input(context));
  const inactive = await save(actor, input(context, { active: false, allowedUserIds: [reader.userId] }));
  await retire(actor, inactive);
  const ids = person => work(person, async client => (await client.query('SELECT instruments_readable_ids() AS id ORDER BY id')).rows.map(row => row.id), true);
  assert.deepEqual(await ids(actor), [allowed.id, hidden.id, inactive.id].sort());
  assert.deepEqual(await ids(reader), [allowed.id, inactive.id].sort());
  assert.deepEqual(await ids(denied), []); assert.deepEqual(await ids(foreign.actor), []);
  await work(actor, (client, identity) => updateRole(client, identity, { id: denied.roleId, revision: 0, requestId: randomUUID(), name: 'All Instruments', capabilityKeys: ['can_access_instruments_all'] }));
  assert.deepEqual(await ids(denied), [allowed.id, hidden.id, inactive.id].sort());
  await work(actor, (client, identity) => updateRole(client, identity, { id: denied.roleId, revision: 1, requestId: randomUUID(), name: 'Restricted Instruments', capabilityKeys: [] }));
  assert.deepEqual(await ids(denied), []);
  await save(actor, { id: allowed.id, revision: 1, requestId: randomUUID(), allowedUserIds: [actor.userId] });
  assert.deepEqual(await ids(reader), [inactive.id]);
  assert.equal((await load(reader, inactive.id, { atRevision: 1 })).active, false);
  await assert.rejects(load(reader, allowed.id, { atRevision: 1 }), { code: 'instrument_not_found' });
  await work(reader, async client => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [actor.userId]);
    assert.equal((await client.query('SELECT instruments_readable_ids()')).rowCount, 0);
  }, true);
  context.modules[2].enabled = false; await saveModuleAccessSettings(actor, context.modules);
  assert.deepEqual(await ids(actor), []); assert.deepEqual(await ids(reader), []);
});

test('concurrent exact retries create one Instrument revision and conflicting edits report stale state', async () => {
  const context = await fixture(); const value = input(context);
  const [first, second] = await Promise.all([save(context.actor, value), save(context.actor, value)]); assert.deepEqual(first, second);
  const requests = ['First change', 'Second change'].map(name => ({ id: first.id, revision: 1, requestId: randomUUID(), name }));
  const changes = await Promise.allSettled(requests.map(request => save(context.actor, request)));
  assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(changes.filter(result => result.reason?.code === 'stale_instrument').length, 1);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM instrument_versions WHERE organization_id=$1 AND instrument_id=$2', [context.actor.organizationId, first.id])).rows[0].count, 2);
});

test('configured Instruments prevent Workflow retirement and Template kind changes', async () => {
  const context = await fixture(); const references = await serviceReferences(context.actor);
  const record = await save(context.actor, input(context, { serviceConfigurations: [{ id: randomUUID(), serviceCode: 'inspection',
    templateId: references.template.templateId, workflowId: references.workflow.workflowId, reminderRoleIds: [context.actor.roleId] }] }));
  await assert.rejects(work(context.actor, (client, identity) => retireWorkflowMaster(client, identity,
    { id: references.workflow.workflowId, requestId: randomUUID(), metadataRevision: 1 })), { code: 'workflow_in_use' });
  await assert.rejects(work(context.actor, client => client.query("UPDATE template_versions SET kind='sample',revision=revision+1 WHERE organization_id=$1 AND id=$2", [context.actor.organizationId, references.template.versionId])), { constraint: 'instrument_template_in_use' });
  await save(context.actor, { id: record.id, revision: 1, requestId: randomUUID(), serviceConfigurations: [] });
  await work(context.actor, (client, identity) => retireWorkflowMaster(client, identity,
    { id: references.workflow.workflowId, requestId: randomUUID(), metadataRevision: 1 }));
  assert.equal((await load(context.actor, record.id, { atRevision: 1 })).serviceConfigurations[0].workflowId, references.workflow.workflowId);
});

test('Instrument saves wait for a Template writer and recheck its committed type change', { timeout: 15000 }, async () => {
  const context = await fixture(); const references = await serviceReferences(context.actor);
  const editor = await account({ organizationId: context.actor.organizationId, permissions: ['templates.manage'] });
  let release; const gate = new Promise(resolve => { release = resolve; }); let ready; const locked = new Promise(resolve => { ready = resolve; });
  let writerError; let pid; let pending; const writer = work(editor, async client => {
    await client.query('SELECT id FROM templates WHERE organization_id=$1 AND id=$2 FOR UPDATE', [editor.organizationId, references.template.templateId]);
    ready(); await gate;
    await client.query("UPDATE template_versions SET kind='sample',revision=revision+1 WHERE organization_id=$1 AND id=$2", [editor.organizationId, references.template.versionId]);
  }).catch(error => { writerError = error; ready(); });
  try {
    await locked; if (writerError) throw writerError;
    pending = work(context.actor, async (client, identity) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return saveInstrumentCore(client, identity, input(context, { serviceConfigurations: [{ id: randomUUID(), serviceCode: 'inspection',
        templateId: references.template.templateId, workflowId: references.workflow.workflowId, reminderRoleIds: [context.actor.roleId] }] }));
    }).then(value => ({ value }), error => ({ error }));
    await waitForLock(() => pid, () => writerError); release(); await writer; if (writerError) throw writerError;
    assert.equal((await pending).error?.code, 'invalid_instrument_service_reference');
    assert.equal((await owner.query('SELECT count(*)::integer AS count FROM instruments WHERE organization_id=$1', [context.actor.organizationId])).rows[0].count, 0);
  } finally { release(); await writer; if (pending) await pending; }
});

test('a Template kind change waits for the first Instrument capture and then rejects its new reference', { timeout: 15000 }, async () => {
  const context = await fixture(); const references = await serviceReferences(context.actor);
  const editor = await account({ organizationId: context.actor.organizationId, permissions: ['templates.manage'] });
  let release; const gate = new Promise(resolve => { release = resolve; }); let ready; const locked = new Promise(resolve => { ready = resolve; });
  let writerError; let pid; let pending;
  const writer = work(context.actor, async (client, identity) => {
    const record = await saveInstrumentCore(client, identity, input(context, { serviceConfigurations: [{ id: randomUUID(), serviceCode: 'inspection',
      templateId: references.template.templateId, workflowId: references.workflow.workflowId, reminderRoleIds: [context.actor.roleId] }] }));
    ready(); await gate; return record;
  }).catch(error => { writerError = error; ready(); });
  try {
    await locked; if (writerError) throw writerError;
    pending = work(editor, async client => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return client.query("UPDATE template_versions SET kind='sample',revision=revision+1 WHERE organization_id=$1 AND id=$2", [editor.organizationId, references.template.versionId]);
    }).then(value => ({ value }), error => ({ error }));
    await waitForLock(() => pid, () => writerError); release(); const record = await writer; if (writerError) throw writerError;
    assert.equal((await pending).error?.constraint, 'instrument_template_in_use');
    assert.equal((await load(context.actor, record.id)).serviceConfigurations[0].templateId, references.template.templateId);
    assert.equal((await owner.query('SELECT kind FROM template_versions WHERE organization_id=$1 AND id=$2', [editor.organizationId, references.template.versionId])).rows[0].kind, 'equipment_service_log');
  } finally { release(); await writer; if (pending) await pending; }
});

test('Instrument saves wait for actual settings and Role writers and recheck their committed revocations', { timeout: 15000 }, async () => {
  for (const kind of ['settings', 'role']) {
    const context = await fixture(); const person = await account({ organizationId: context.actor.organizationId, permissions: ['instruments.manage'] });
    context.modules[2].userIds.push(person.userId); await saveModuleAccessSettings(context.actor, context.modules);
    let release; const gate = new Promise(resolve => { release = resolve; }); let ready; const locked = new Promise(resolve => { ready = resolve; });
    let writerError; let pid; let pending;
    const writer = work(context.actor, async (client, identity) => {
      if (kind === 'settings') {
        const { settings } = await loadLaboratorySettings(client, identity);
        await saveLaboratorySettings(client, identity, { revision: settings.revision, autoCreateJobs: false, moduleAccess: emptyModuleAccess() });
      } else await updateRole(client, identity, { id: person.roleId, revision: 0, requestId: randomUUID(), name: 'Revoked Instrument manager', permissionCodes: [] });
      ready(); await gate;
    }).catch(error => { writerError = error; ready(); });
    try {
      await locked; if (writerError) throw writerError;
      pending = work(person, async (client, identity) => {
        pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return saveInstrumentCore(client, identity, input(context));
      }).then(value => ({ value }), error => ({ error }));
      await waitForLock(() => pid, () => writerError); release(); await writer; if (writerError) throw writerError;
      assert.equal((await pending).error?.status, 403);
      assert.equal((await owner.query('SELECT count(*)::integer AS count FROM instruments WHERE organization_id=$1', [context.actor.organizationId])).rows[0].count, 0);
    } finally { release(); await writer; if (pending) await pending; }
  }
});
