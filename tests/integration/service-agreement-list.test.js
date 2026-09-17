import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool } from '../helpers/database.js';
import { agreementAccount, agreementWork as work, serviceAgreementFixture, serviceAgreementCommand } from '../helpers/service-agreements.js';
import { saveModuleAccessSettings } from '../helpers/module-access.js';
import { publicIdentity } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listServiceAgreements } from '../../src/masters/service-agreement-list.js';
import { serviceAgreementOptions } from '../../src/masters/service-agreement-options.js';
import { saveServiceAgreement, retireServiceAgreement } from '../../src/masters/service-agreements.js';
import { saveInstrumentCore, retireInstrumentCore } from '../../src/instruments/core.js';
import { saveVendor } from '../../src/masters/vendors.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const list = (actor, input = {}) => work(actor, (client, identity) => listServiceAgreements(client, identity, input), true);
const options = (actor, input) => work(actor, (client, identity) => serviceAgreementOptions(client, identity, input), true);
const save = (actor, input) => work(actor, (client, identity) => saveServiceAgreement(client, identity, input));

test('Agreement listing searches and filters current references, literal text, numeric zero and inclusive calendar dates with bounded queries', async () => {
  const context = await serviceAgreementFixture(owner); const { actor } = context;
  const first = await save(actor, serviceAgreementCommand(context));
  const second = await save(actor, serviceAgreementCommand(context, { instrumentIds: [context.instruments[1].id], cost: '125.25', startDate: '2027-01-01', endDate: '2027-12-31' }));
  await work(actor, (client, identity) => saveVendor(client, identity, { id: context.vendor.id, revision: 1, requestId: randomUUID(), name: 'Vendor 100%_literal' }));
  await work(actor, (client, identity) => saveInstrumentCore(client, identity, { id: context.instruments[0].id, revision: 1, requestId: randomUUID(), name: 'Renamed Apparatus' }));
  assert.equal((await list(actor, { search: '100%_literal' })).totalCount, 2);
  assert.equal((await list(actor, { search: '%' })).totalCount, 2);
  assert.equal((await list(actor, { search: 'Agreement Vendor' })).totalCount, 0);
  const byEquipment = await list(actor, { search: 'Renamed Apparatus' }); assert.equal(byEquipment.totalCount, 1); assert.equal(byEquipment.rows[0]._id, first.id);
  assert.deepEqual(byEquipment.rows[0].equipment_ids, ['Renamed Apparatus', 'Agreement Instrument 1']);
  assert.equal((await list(actor, { search: '01/01/2026' })).rows[0]._id, first.id);
  assert.equal((await list(actor, { search: '2027-12-31' })).rows[0]._id, second.id);
  assert.equal((await list(actor, { filters: { cost: { type: 'text', value: '0.00' } } })).rows[0]._id, first.id);
  assert.equal((await list(actor, { filters: { start_date: { type: 'date', from: '2027-01-01', to: '2027-01-01' } } })).rows[0]._id, second.id);
  assert.equal((await list(actor, { filters: { equipment_ids: { type: 'relation', value: [context.instruments[0].id], labels: {} },
    vendor_id: { type: 'relation', value: [context.vendor.id] } } })).rows[0]._id, first.id);
  assert.equal((await list(actor, { filters: { equipment_ids: { type: 'relation', value: [randomUUID()] } } })).totalCount, 0);
  for (const key of ['vendor_id', 'equipment_ids', 'start_date', 'end_date', 'cost']) assert.equal((await list(actor, { sort: { key, dir: 'asc' }, pageSize: 1 })).rows.length, 1);
  assert.equal((await list(actor, { sort: { key: 'cost', dir: 'desc' }, pageSize: 1 })).rows[0]._id, second.id);
  assert.equal((await list(actor, { sort: { key: 'cost', dir: 'desc' }, pageSize: 1, page: 2 })).rows[0]._id, first.id);
  await work(actor, async (client, identity) => {
    let queries = 0; const counted = { query: (...args) => { queries++; return client.query(...args); } };
    assert.equal((await listServiceAgreements(counted, identity)).rows.length, 2); assert.equal(queries, 4);
  }, true);
  await work(actor, (client, identity) => retireServiceAgreement(client, identity, { id: first.id, revision: 1, requestId: randomUUID() }));
  assert.equal((await list(actor)).totalCount, 1); assert.equal((await list(actor, { page: 2 })).rows.length, 0);
});

test('Agreement choices page and search inactive references and retain late selections without requiring other modules', async () => {
  const context = await serviceAgreementFixture(owner); const { actor } = context; const ids = [];
  await work(actor, async (client, identity) => {
    for (let index = 0; index < 125; index++) {
      const record = await saveInstrumentCore(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(), name: `Choice ${String(index).padStart(3, '0')} échelle`, code: randomUUID(),
        laboratoryId: context.laboratoryId, dateOfInstallation: '2026-01-01', allowedUserIds: [actor.userId], active: index % 2 === 0 }); ids.push(record.id);
    }
  });
  const viewer = await agreementAccount(owner, { organizationId: actor.organizationId, permissions: ['masters.read'] });
  context.modules[3].userIds.push(viewer.userId); await saveModuleAccessSettings(actor, context.modules);
  const identity = await work(viewer, publicIdentity, true);
  assert.deepEqual(identity.masterModules, { customer: false, vendor: false, instrument: false, service_agreements: true });
  const first = await options(viewer, { kind: 'instruments', selectedIds: [ids[124]] }); assert.equal(first.rows.length, 100); assert.equal(first.hasMore, true);
  assert.equal(first.retained[0].id, ids[124]); assert(first.rows.some(row => !row.active));
  const second = await options(viewer, { kind: 'instruments', page: 2 }); assert.equal(second.rows.length, 27); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 127);
  assert.equal((await options(viewer, { kind: 'instruments', search: 'choice 124 ECHELLE' })).rows[0].id, ids[124]);
  assert.equal((await options(viewer, { kind: 'instruments', search: ids[123].toUpperCase() })).rows[0].id, ids[123]);
  assert.equal((await options(viewer, { kind: 'vendors' })).rows[0].active, false);
  await work(actor, (client, identity) => retireInstrumentCore(client, identity, { id: ids[124], revision: 1, requestId: randomUUID() }));
  const removed = await options(viewer, { kind: 'instruments', search: ids[124], selectedIds: [ids[124]] }); assert.deepEqual(removed.rows, []); assert.deepEqual(removed.retained, []);
  const denied = await agreementAccount(owner, { organizationId: actor.organizationId });
  await assert.rejects(options(denied, { kind: 'instruments' }), { status: 403 }); await assert.rejects(list(denied), { status: 403 });
  const foreign = await serviceAgreementFixture(owner); assert.equal((await options(foreign.actor, { kind: 'instruments', selectedIds: [ids[0]], search: ids[0] })).retained.length, 0);
});

test('Agreement list and choices reject unsupported, malformed and excessive inputs', async () => {
  const { actor } = await serviceAgreementFixture(owner);
  for (const input of [{ page: 0 }, { pageSize: 101 }, { search: '\0' }, { search: '\ud800' }, { sort: { key: 'notes', dir: 'asc' } },
    { sort: { key: 'cost', dir: 'desc;select 1' } }, { filters: { cost: { type: 'relation', value: [] } } },
    { filters: { start_date: { type: 'date', from: '2026-02-30' } } }, { filters: { end_date: { type: 'date', from: '2027-01-01', to: '2026-12-31' } } },
    { filters: { vendor_id: { type: 'relation', value: [null] } } }, { filters: { equipment_ids: { type: 'relation', value: Array(501).fill(randomUUID()) } } }]) {
    await assert.rejects(list(actor, input), { status: 400 });
  }
  const id = randomUUID();
  for (const input of [{ kind: 'users' }, { kind: 'instruments', page: 0 }, { kind: 'vendors', search: '\0' }, { kind: 'vendors', selectedIds: [id, id] },
    { kind: 'instruments', selectedIds: [null] }, { kind: 'instruments', selectedIds: Array(501).fill(id) }]) await assert.rejects(options(actor, input), { status: 400 });
});
