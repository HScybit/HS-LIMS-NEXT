import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveInstrumentCore } from '../../src/instruments/core.js';
import { saveVendor } from '../../src/masters/vendors.js';
import { listInstrumentServiceLogs, createInstrumentServiceLog, updateInstrumentServiceLog,
  listInstrumentBreakdownLogs, createInstrumentBreakdownLog, resolveInstrumentBreakdownLog } from '../../src/equipment-logs/service.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['instruments.manage', 'instruments.read', 'instrument_services.manage', 'settings.manage', 'masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}

async function fixture() {
  const actor = await account(); const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'INST-LAB','Instrument laboratory')", [actor.organizationId, laboratoryId]);
  const modules = emptyModuleAccess(); modules[1] = { ...modules[1], enabled: true, userIds: [actor.userId] }; modules[2] = { ...modules[2], enabled: true, userIds: [actor.userId] };
  await saveModuleAccessSettings(actor, modules);
  const instrument = await work(actor, (client, identity) => saveInstrumentCore(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
    name: 'Synthetic Instrument', code: 'Inst-' + randomUUID(), laboratoryId, dateOfInstallation: '2026-09-17', allowedUserIds: [actor.userId] }));
  const vendor = await work(actor, (client, identity) => saveVendor(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(),
    name: 'Synthetic Vendor', legalName: 'Synthetic Vendor Pvt Ltd',
    contactPersonName: 'Synthetic contact', contactPersonEmail: 'equipment-vendor@example.invalid', contactPersonPhone: '0000000000' }));
  return { actor, instrument, vendorId: vendor.id };
}

test('a service log can be created and updated with revision locking, only against a loggable service type', async () => {
  const { actor, instrument, vendorId } = await fixture();
  // "breakdown" is a valid Instrument service type (see instruments/service-types.js), but
  // breakdown events go through their own instrument_breakdown_logs table/API instead.
  await assert.rejects(work(actor, (client, identity) => createInstrumentServiceLog(client, identity, instrument.id,
    { serviceCode: 'breakdown', serviceDate: '2026-04-01', summary: 'Should be rejected' })), { code: 'invalid_service_code' });
  const created = await work(actor, (client, identity) => createInstrumentServiceLog(client, identity, instrument.id,
    { serviceCode: 'calibration', serviceDate: '2026-04-01', nextServiceOn: '2026-07-01', summary: 'Routine calibration', vendorId, cost: '150.50' }));
  assert.equal(created.serviceCode, 'calibration'); assert.equal(created.revision, 1);
  const listed = await work(actor, (client, identity) => listInstrumentServiceLogs(client, identity, instrument.id), true);
  assert.equal(listed.items.length, 1);
  const updated = await work(actor, (client, identity) => updateInstrumentServiceLog(client, identity, instrument.id, created.id,
    { revision: created.revision, serviceCode: 'calibration', serviceDate: '2026-04-01', nextServiceOn: '2026-07-15', summary: 'Routine calibration, rescheduled' }));
  assert.equal(updated.nextServiceOn, '2026-07-15'); assert.equal(updated.revision, 2);
  await assert.rejects(work(actor, (client, identity) => updateInstrumentServiceLog(client, identity, instrument.id, created.id,
    { revision: created.revision, serviceCode: 'calibration', serviceDate: '2026-04-01', summary: 'Stale' })), { code: 'service_log_changed' });
});

test('a next-service date before the service date is rejected', async () => {
  const { actor, instrument } = await fixture();
  await assert.rejects(work(actor, (client, identity) => createInstrumentServiceLog(client, identity, instrument.id,
    { serviceCode: 'calibration', serviceDate: '2026-04-10', nextServiceOn: '2026-04-01', summary: 'Invalid schedule' })), { code: 'invalid_next_service_date' });
});

test('a breakdown can be logged and resolved, requiring a vendor and rejecting a second resolution', async () => {
  const { actor, instrument, vendorId } = await fixture();
  const logged = await work(actor, (client, identity) => createInstrumentBreakdownLog(client, identity, instrument.id,
    { breakdownDate: '2026-04-05', summary: 'Balance stopped responding' }));
  assert.equal(logged.status, 'open');
  await assert.rejects(work(actor, (client, identity) => resolveInstrumentBreakdownLog(client, identity, instrument.id, logged.id,
    { revision: logged.revision, resolvedOn: '2026-04-06', cost: '75', comments: 'Fixed' })), { code: 'invalid_resolution' });
  const resolved = await work(actor, (client, identity) => resolveInstrumentBreakdownLog(client, identity, instrument.id, logged.id,
    { revision: logged.revision, resolvedOn: '2026-04-06', vendorId, cost: '75', comments: 'Replaced load cell' }));
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.resolutionCost, '75');
  await assert.rejects(work(actor, (client, identity) => resolveInstrumentBreakdownLog(client, identity, instrument.id, logged.id,
    { revision: resolved.revision, resolvedOn: '2026-04-07', vendorId, cost: '10', comments: 'Again' })), { code: 'breakdown_already_resolved' });
  const listed = await work(actor, (client, identity) => listInstrumentBreakdownLogs(client, identity, instrument.id), true);
  assert.equal(listed.items[0].status, 'resolved');
});
