import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { saveProduct, retireProduct } from '../../src/masters/products.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
async function account(options) {
  const user = await createAccount(owner, options);
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
async function setup() {
  const author = await account({ permissions: ['masters.manage', 'samples.create', 'samples.manage'] });
  const registrar = await account({ organizationId: author.organizationId, permissions: ['samples.create'] });
  const fixture = await createLaboratoryFixture(owner, author, { repeated: false });
  const command = { id: fixture.product.id, revision: 1, requestId: randomUUID(), key: fixture.product.code,
    name: fixture.product.name, description: 'Captured Product description', abbreviation: '0' };
  return { author, registrar, fixture, command };
}
async function line(user, sampleId) {
  return (await owner.query('SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [user.organizationId, sampleId])).rows[0];
}
function insertLine(client, selected, changes = {}) {
  const row = { ...selected, ...changes };
  return client.query(`INSERT INTO sample_products
    (organization_id,id,sample_id,product_id,sample_category_id,product_revision,product_code,product_name,category_code,category_name,display_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.organization_id, randomUUID(), row.sample_id, row.product_id,
    row.sample_category_id, row.product_revision, row.product_code, row.product_name, row.category_code, row.category_name, row.display_order + 1]);
}

test('registration pins actual Product and custom-field history without inventing versions for earlier lines', async () => {
  const { author, registrar, fixture, command } = await setup();
  const earlier = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  assert.equal((await line(author, earlier.id)).product_revision, null);
  const definitions = ['number', 'checkbox'].map((fieldType, index) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(),
    fieldType, key: fieldType, label: `Original ${fieldType}`, associatedWith: 'product', displayOrder: index }));
  for (const definition of definitions) await work(author, (client, identity) => saveCustomField(client, identity, definition));
  const values = [0, false].map((value, index) => ({ fieldId: definitions[index].id, fieldRevision: 1, value }));
  const saved = await work(author, (client, identity) => saveProduct(client, identity, { ...command, customFields: values }));
  const sample = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  const captured = await line(author, sample.id);
  assert.equal(captured.product_revision, saved.revision); assert.equal(saved.revision, 2);
  assert.equal((await work(registrar, (client) => client.query('SELECT 1 FROM product_versions'))).rowCount, 0);
  await work(author, (client, identity) => saveCustomField(client, identity, { ...definitions[0], revision: 1,
    requestId: randomUUID(), key: 'renamed_number', label: 'Later number' }));
  await work(author, (client, identity) => saveProduct(client, identity, { ...command, revision: 2, requestId: randomUUID(),
    key: randomUUID(), name: 'Later Product', description: 'Changed description',
    customFields: [{ ...values[0], fieldRevision: 2, value: 12 }, { ...values[1], value: true }] }));
  assert.deepEqual(await line(author, sample.id), captured);
  assert.equal((await line(author, earlier.id)).product_revision, null);
  const history = (await owner.query(`SELECT version.description,definition.key,definition.label,field.display_number,field.display_boolean
    FROM sample_products line JOIN product_versions version ON version.organization_id=line.organization_id
      AND version.product_id=line.product_id AND version.revision=line.product_revision
    JOIN product_version_custom_fields field ON field.organization_id=version.organization_id AND field.product_id=version.product_id AND field.revision=version.revision
    JOIN custom_field_versions definition ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE line.organization_id=$1 AND line.id=$2 ORDER BY field.position`, [author.organizationId, captured.id])).rows;
  assert.deepEqual(history, [
    { description: command.description, key: 'number', label: 'Original number', display_number: 0, display_boolean: null },
    { description: command.description, key: 'checkbox', label: 'Original checkbox', display_number: null, display_boolean: false },
  ]);
  const later = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  assert.equal((await line(author, later.id)).product_revision, 3);
  await work(author, (client, identity) => retireProduct(client, identity, { id: saved.id, revision: 3, requestId: randomUUID() }));
  assert.deepEqual(await line(author, sample.id), captured);
});

test('sample Product bindings reject rebinding, forged captures and foreign or missing history', async () => {
  const { author, registrar, fixture, command } = await setup();
  await work(author, (client, identity) => saveProduct(client, identity, command));
  const sample = await work(registrar, (client, identity) => registerSample(client, identity, fixture.registration));
  const captured = await line(author, sample.id);
  await work(author, (client, identity) => saveProduct(client, identity, { ...command, revision: 2, requestId: randomUUID() }));
  for (const [column, value] of [['product_revision', 3], ['product_revision', null], ['product_name', 'Changed'], ['product_code', 'Changed'],
    ['product_id', randomUUID()], ['sample_id', randomUUID()]]) {
    const update = (client) => client.query(`UPDATE sample_products SET ${column}=$3 WHERE organization_id=$1 AND id=$2`, [author.organizationId, captured.id, value]);
    await assert.rejects(work(author, update), { code: '55000' });
    await assert.rejects(update(owner), { code: '55000' });
  }
  await assert.rejects(work(author, (client) => insertLine(client, captured)), { code: '23514', constraint: 'sample_product_current_history' });
  await assert.rejects(work(author, (client) => insertLine(client, captured, { product_revision: null, product_name: 'Forged' })), { code: '23514', constraint: 'sample_product_current_history' });
  await assert.rejects(insertLine(owner, captured, { product_revision: 999 }), { code: '23503', constraint: 'sample_product_history_fk' });
  const foreign = await setup();
  await work(foreign.author, (client, identity) => saveProduct(client, identity, foreign.command));
  await assert.rejects(work(author, (client) => insertLine(client, captured, { product_id: foreign.fixture.product.id })), { code: '23514' });
  await assert.rejects(work(author, (client) => insertLine(client, captured, { organization_id: foreign.author.organizationId })), { code: '42501' });
  await assert.rejects(work(foreign.registrar, (client, identity) => registerSample(client, identity, fixture.registration)), { code: 'invalid_sample_reference' });
  await work(author, (client) => client.query("UPDATE sample_products SET description='Line detail edited' WHERE organization_id=$1 AND id=$2", [author.organizationId, captured.id]));
  assert.deepEqual(await line(author, sample.id), { ...captured, description: 'Line detail edited' });
});

test('registration holds a consistent Product version while a simultaneous master edit waits', async () => {
  const { author, registrar, fixture, command } = await setup();
  await work(author, (client, identity) => saveProduct(client, identity, command));
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let registered; const ready = new Promise((resolve) => { registered = resolve; });
  let writing; const writerReady = new Promise((resolve) => { writing = resolve; });
  let registeringPid; let writerPid; let saving;
  const registration = work(registrar, async (client, identity) => {
    registeringPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const sample = await registerSample(client, identity, fixture.registration);
    registered(); await gate; return sample;
  });
  try {
    await Promise.race([ready, registration]);
    saving = work(author, async (client, identity) => {
      writerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; writing();
      return saveProduct(client, identity, { ...command, revision: 2, requestId: randomUUID(), name: 'Concurrent later Product' });
    });
    await Promise.race([writerReady, saving]);
    const deadline = Date.now() + 5000; let blockers = [];
    while (Date.now() < deadline) {
      blockers = (await owner.query('SELECT pg_blocking_pids($1) AS blockers', [writerPid])).rows[0].blockers;
      if (blockers.includes(registeringPid)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blockers.includes(registeringPid), 'The master edit waits for the actual registering transaction');
  } finally {
    release();
    await Promise.allSettled([registration, ...(saving ? [saving] : [])]);
  }
  const sample = await registration; const saved = await saving;
  const captured = await line(author, sample.id);
  assert.equal(captured.product_revision, 2); assert.equal(captured.product_name, command.name);
  assert.equal(saved.revision, 3); assert.equal(saved.name, 'Concurrent later Product');
});
