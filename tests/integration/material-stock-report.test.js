import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from '../helpers/module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveMaterialCategory } from '../../src/masters/material-categories.js';
import { createMaterialTransaction, saveMaterial, getMaterialStockReport } from '../../src/materials/service.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}, configured = true) {
  const actor = await createAccount(owner, { permissions: ['masters.manage', 'settings.manage'], ...options });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  if (configured) await saveModuleAccessSettings(actor, emptyModuleAccess().map(module => module.moduleKey === 'inventory' ? { ...module, enabled: true, userIds: [actor.userId] } : module));
  return actor;
}
async function setup({ initialQuantity = '10' } = {}) {
  const actor = await account();
  const category = await work(actor, (client, identity) => saveMaterialCategory(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, name: `Stock report category ${randomUUID()}` }));
  const unit = (await owner.query(`INSERT INTO measurement_units(organization_id,code,name,symbol) VALUES($1,$2,'Grams','g') RETURNING id`, [actor.organizationId, randomUUID()])).rows[0];
  const material = await work(actor, (client, identity) => saveMaterial(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Stock report material',
    code: randomUUID(), description: '', categoryId: category.id, measurementUnitId: unit.id, initialQuantity, minimumQuantity: '0' }));
  return { actor, category, material };
}
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
after(async () => { await closePool(); await owner.end(); });

test('the stock report reflects opening quantity plus inbound transactions as of today, defaulting when omitted, and can draw down via an outbound transaction', async () => {
  const { actor, material } = await setup({ initialQuantity: '10' });
  const batchSerialNumber = randomUUID();
  await work(actor, (client, identity) => createMaterialTransaction(client, identity, { id: randomUUID(), requestId: randomUUID(), materialId: material.id,
    type: 'in', quantity: '5', cost: '2', supplier: 'Supplier', batchSerialNumber }));
  await work(actor, (client, identity) => createMaterialTransaction(client, identity, { id: randomUUID(), requestId: randomUUID(), materialId: material.id,
    type: 'out', quantity: '2', batchSerialNumber }));
  const report = await work(actor, (client, identity) => getMaterialStockReport(client, identity, {}));
  assert.equal(report.asOnDate, today());
  const row = report.items.find((item) => item.id === material.id);
  assert.equal(row.inboundQuantity, '5'); assert.equal(row.outboundQuantity, '2'); assert.equal(row.currentQuantity, '13');
});

test('materials and transactions recorded after the as-of date are excluded', async () => {
  const { actor, material } = await setup({ initialQuantity: '10' });
  await work(actor, (client, identity) => createMaterialTransaction(client, identity, { id: randomUUID(), requestId: randomUUID(), materialId: material.id,
    type: 'in', quantity: '5', cost: '2', supplier: 'Supplier', batchSerialNumber: randomUUID() }));
  const report = await work(actor, (client, identity) => getMaterialStockReport(client, identity, { asOnDate: yesterday() }));
  assert.equal(report.items.find((item) => item.id === material.id), undefined);
});

test('a future as-of date is rejected', async () => {
  const { actor } = await setup();
  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await assert.rejects(work(actor, (client, identity) => getMaterialStockReport(client, identity, { asOnDate: future })), { code: 'future_stock_date' });
});
