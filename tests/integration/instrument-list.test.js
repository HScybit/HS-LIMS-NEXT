import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveInstrumentCore, retireInstrumentCore } from '../../src/instruments/core.js';
import { listInstruments, instrumentOverview, instrumentFilterOptions } from '../../src/instruments/list.js';
import { instrumentOptions, instrumentServiceTypes } from '../../src/instruments/options.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { createTemplate } from '../../src/templates/authoring.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const actor = await account({ permissions: ['instruments.manage', 'settings.manage', 'masters.manage', 'workflows.manage', 'templates.manage'] });
  const reader = await account({ organizationId: actor.organizationId, permissions: ['instruments.read'] });
  const modules = emptyModuleAccess(); modules[2] = { ...modules[2], enabled: true, userIds: [actor.userId, reader.userId] };
  const services = ['external_calibration', 'internal_calibration', 'preventive_maintenance', 'inspection', 'breakdown'].map(serviceCode =>
    ({ id: randomUUID(), serviceCode, displayLabel: serviceCode, isActive: true }));
  await saveModuleAccessSettings(actor, modules, { instrumentServiceTypes: services });
  const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'LIST','École lab')", [actor.organizationId, laboratoryId]);
  return { actor, reader, modules, services, laboratoryId };
}
const save = (context, changes = {}) => work(context.actor, (client, identity) => saveInstrumentCore(client, identity,
  { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Instrument', code: 'IN-' + randomUUID(), laboratoryId: context.laboratoryId,
    dateOfInstallation: '2026-09-17', allowedUserIds: [context.reader.userId], ...changes }));
const list = (actor, input) => work(actor, (client, identity) => listInstruments(client, identity, input), true);
const day = delta => { const date = new Date(); date.setDate(date.getDate() + delta); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const display = value => value.split('-').reverse().join('/');
const service = (serviceCode, changes = {}) => ({ id: randomUUID(), serviceCode, reminderBeforeDays: 2, ...changes });

test('Instrument list follows worst canonical service status, stable ties, dates, empty schedules and inactive records', async () => {
  const context = await fixture();
  const scheduled = await save(context, { name: 'Scheduled', serviceConfigurations: [
    service('external_calibration', { lastPerformedOn: day(-20), nextReminderOn: day(-2) }),
    service('internal_calibration', { lastPerformedOn: day(-5), nextReminderOn: day(-1) }),
    service('preventive_maintenance', { lastPerformedOn: day(-10), nextReminderOn: day(7) }),
    service('inspection', { lastPerformedOn: day(0), nextReminderOn: day(-100) }),
    service('breakdown', { lastPerformedOn: day(0), nextReminderOn: day(-100) }),
  ] });
  await save(context, { name: 'Due today', serviceConfigurations: [service('external_calibration', { lastPerformedOn: day(-3), frequencyDays: 3 })] });
  await save(context, { name: 'Due soon', serviceConfigurations: [service('external_calibration', { nextReminderOn: day(2) })] });
  await save(context, { name: 'Maintenance overdue', serviceConfigurations: [service('preventive_maintenance', { nextReminderOn: day(-1) })] });
  await save(context, { name: 'Unscheduled inactive', active: false, calibrated: false });
  const retired = await save(context);
  await work(context.actor, (client, identity) => retireInstrumentCore(client, identity, { id: retired.id, revision: 1, requestId: randomUUID() }));
  const result = await list(context.reader, { pageSize: 100 }); assert.equal(result.totalCount, 5);
  const row = result.rows.find(item => item._id === scheduled.id);
  assert.equal(row.calibrated, 'No'); assert.equal(row.lastServiceOn, display(day(-10))); assert.equal(row.nextServiceOn, display(day(-2)));
  assert.equal(result.rows.find(item => item.name === 'Due today').calibrated, 'Yes');
  assert.equal(result.rows.find(item => item.name === 'Due soon').calibrated, 'Yes');
  assert.equal(result.rows.find(item => item.name === 'Unscheduled inactive').calibrated, '');
  assert.deepEqual(await work(context.reader, (client, identity) => instrumentOverview(client, identity), true), { health: { total: 5, healthy: 3, inBreakdown: 0, maintenanceOverdue: 1, notCalibrated: 1, noCalibrationData: 2, calibrated: 2 } });
});

test('Instrument search, exact filters and page clamping include configured fields and preserve literal wildcard text', async () => {
  const context = await fixture();
  const definition = await work(context.actor, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), revision: 0, requestId: randomUUID(), key: 'asset', label: 'Asset', associatedWith: 'instrument', fieldType: 'text', showInList: true, showInFilter: true }));
  const saved = await save(context, { name: '100%_match', make: 'Maker', customFields: [{ fieldId: definition.id, fieldRevision: 1, value: 'Shelf%_' }] });
  await save(context, { name: '100XXmatch', make: 'Maker two', customFields: [{ fieldId: definition.id, fieldRevision: 1, value: 'Elsewhere' }] });
  for (const search of ['%_', 'Shelf%_', 'École', saved.code]) {
    const result = await list(context.reader, { search, page: 999, pageSize: 1 });
    assert.equal(result.page, search === 'École' ? 2 : 1); assert.equal(result.totalCount, search === 'École' ? 2 : 1);
  }
  const filtered = await list(context.reader, { filters: { make: 'Maker', status: 'Working', lab: 'École lab', ['pf:' + definition.id]: 'helf%' } });
  assert.equal(filtered.rows[0]._id, saved.id); assert.equal(filtered.rows[0].customFields[definition.id].displayValue, 'Shelf%_');
  assert.equal((await list(context.reader, { filters: { make: 'Mak' }, page: 500 })).page, 1);
  assert.deepEqual((await work(context.reader, (client, identity) => instrumentFilterOptions(client, identity, { kind: 'make', search: 'Maker' }), true)).rows,
    [{ value: 'Maker', label: 'Maker' }, { value: 'Maker two', label: 'Maker two' }]);
  await assert.rejects(list(context.reader, { filters: { status: 'available' } }), { status: 400 });
  await assert.rejects(list(context.reader, { filters: { unknown: 'x' } }), { status: 400 });
});

test('Instrument lists, aggregates and choices use current configured and record access', async () => {
  const context = await fixture(); await save(context); await save(context, { allowedUserIds: [context.actor.userId] });
  assert.equal((await list(context.reader)).totalCount, 1); assert.equal((await list(context.actor)).totalCount, 2);
  assert.equal((await work(context.reader, (client, identity) => instrumentOverview(client, identity), true)).health.total, 1);
  const foreign = await fixture(); assert.equal((await list(foreign.actor)).totalCount, 0);
  const unassigned = await account({ organizationId: context.actor.organizationId, permissions: ['instruments.manage'] });
  for (const action of [listInstruments, instrumentOverview, (client, identity) => instrumentOptions(client, identity, { kind: 'users' })]) {
    await assert.rejects(work(unassigned, action, true), { status: 403 });
  }
  context.modules[2].userIds = [context.actor.userId]; await saveModuleAccessSettings(context.actor, context.modules);
  await assert.rejects(list(context.reader), { status: 403 });
});

test('Instrument status uses the supplied viewer calendar day at due-date boundaries', async () => {
  const context = await fixture(); await save(context, { serviceConfigurations: [service('external_calibration', { nextReminderOn: '2026-09-17' })] });
  assert.equal((await list(context.reader, { asOfDate: '2026-09-17' })).rows[0].calibrated, 'Yes');
  assert.equal((await list(context.reader, { asOfDate: '2026-09-18' })).rows[0].calibrated, 'No');
  assert.equal((await work(context.reader, (client, identity) => instrumentOverview(client, identity, { asOfDate: '2026-09-18' }), true)).health.healthy, 0);
  await assert.rejects(list(context.reader, { asOfDate: '2026-02-29' }), { status: 400 });
});

test('Instrument choices match source Unicode search, retain inactive selections and scope service references', async () => {
  const context = await fixture();
  const options = input => work(context.actor, (client, identity) => instrumentOptions(client, identity, input), true);
  assert.equal((await options({ kind: 'laboratories', search: 'ecole' })).rows[0].id, context.laboratoryId);
  await owner.query('UPDATE laboratories SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [context.actor.organizationId, context.laboratoryId]);
  const inactive = await options({ kind: 'laboratories', selectedIds: [context.laboratoryId] });
  assert.equal(inactive.rows.length, 0); assert.equal(inactive.retained[0].name, 'École lab'); assert.equal(inactive.retained[0].active, false);
  const template = await work(context.actor, (client, identity) => createTemplate(client, identity, { name: 'Instrument template', kind: 'equipment_service_log' }));
  await work(context.actor, (client, identity) => createTemplate(client, identity, { name: 'Other template', kind: 'datasheet' }));
  const workflow = await work(context.actor, (client, identity) => createWorkflowMaster(client, identity,
    { id: randomUUID(), metadataRevision: 0, requestId: randomUUID(), name: 'Instrument workflow', appliesTo: 'instrument_service' }));
  await work(context.actor, (client, identity) => createWorkflowMaster(client, identity,
    { id: randomUUID(), metadataRevision: 0, requestId: randomUUID(), name: 'Sample workflow', appliesTo: 'sample' }));
  assert.deepEqual((await options({ kind: 'templates' })).rows.map(row => row.id), [template.templateId]);
  assert.deepEqual((await options({ kind: 'workflows' })).rows.map(row => row.id), [workflow.workflowId]);
  assert.equal((await work(context.actor, instrumentServiceTypes, true)).rows.length, 5);
  context.services[3].isActive = false;
  await saveModuleAccessSettings(context.actor, context.modules, { instrumentServiceTypes: context.services });
  assert.equal((await work(context.actor, instrumentServiceTypes, true)).rows.length, 4);
  await assert.rejects(options({ kind: 'users', selectedIds: [context.actor.userId, context.actor.userId] }), { status: 400 });
});
