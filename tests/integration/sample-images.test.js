import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadSampleImage, readSampleImage } from '../../src/samples/images.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';
import { sampleEditForm, sampleEditPayload } from '../../src/samples/edit-form.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';

const owner = ownerPool(); let manager; let creator; let reader; let denied; let foreign; let content;
const permissions = ['samples.create', 'samples.read', 'samples.manage', 'test_requests.allocate', 'masters.manage', 'templates.manage', 'datasheets.execute', 'settings.manage'];
const work = (user, action) => withSession(user.token, action, { csrfToken: user.csrfToken });
const fails = code => error => (error.code ?? error.cause?.code) === code;
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
before(async () => {
  manager = await account();
  creator = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  denied = await account({ organizationId: manager.organizationId, permissions: ['templates.read'] });
  foreign = await account();
  content = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
});
after(async () => { await closePool(); await owner.end(); });
const input = overrides => ({ requestId: randomUUID(), originalName: 'Sample β.png', mediaType: 'image/png', content, ...overrides });
const upload = (user = manager, value = input()) => work(user, (client, identity) => uploadSampleImage(client, identity, value));
const load = id => work(manager, (client, identity) => loadSample(client, identity, id));
const options = { allowReceivingDateEdit: true, sampleCategories: [] };
async function setup(images, user = manager) {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const registration = { ...fixture.registration, products: images.map(image => ({ ...structuredClone(fixture.registration.products[0]), imageFileId: image?.id ?? null })) };
  const created = await work(user, (client, identity) => registerSample(client, identity, registration));
  return { fixture, registration, sample: await load(created.id) };
}
async function save(sample, change, user = manager) {
  const form = sampleEditForm(sample); change(form);
  return work(user, (client, identity) => updateSample(client, identity, sample.id, sampleEditPayload(form, sample, options)));
}

test('uploads record the actual actor, preserve bytes and replay exact concurrent requests', async () => {
  const command = input(); const result = await Promise.all([upload(manager, command), upload(manager, command)]);
  assert.equal(result.filter(item => item.replayed).length, 1); assert.equal(result[0].id, result[1].id);
  assert.equal(result[0].uploadedBy, manager.userId);
  const file = await work(reader, (client, identity) => readSampleImage(client, identity, result[0].id));
  assert.deepEqual(file.content, content); assert.equal(file.originalName, command.originalName);
  assert.equal(file.width, 12); assert.equal(file.height, 8);
  await assert.rejects(upload(manager, { ...command, originalName: 'changed.png' }), fails('sample_image_request_reused'));
});

test('upload and read permissions isolate tenants and let a creator preview their own draft', async () => {
  const own = await upload(creator); const another = await upload(); const outside = await upload(foreign);
  assert.deepEqual((await work(creator, (client, identity) => readSampleImage(client, identity, own.id))).content, content);
  await assert.rejects(work(creator, (client, identity) => readSampleImage(client, identity, another.id)), fails('sample_image_not_found'));
  for (const user of [reader, denied]) await assert.rejects(upload(user), fails('forbidden'));
  await assert.rejects(work(denied, (client, identity) => readSampleImage(client, identity, own.id)), fails('forbidden'));
  await assert.rejects(work(manager, (client, identity) => readSampleImage(client, identity, outside.id)), fails('sample_image_not_found'));
  assert.equal((await work(creator, client => client.query('SELECT id FROM sample_image_assets WHERE organization_id=$1 AND id=$2', [manager.organizationId, another.id]))).rowCount, 0);
  const { sample } = await setup([own], creator); assert.equal(sample.products[0].imageFileId, own.id);
});

test('SQL enforces immutable content, actor identity, permissions and tenant-scoped image references', async () => {
  const file = await upload(); const outside = await upload(foreign); const { sample } = await setup([file]);
  await assert.rejects(owner.query('UPDATE sample_image_assets SET original_name=$3 WHERE organization_id=$1 AND id=$2', [manager.organizationId, file.id, 'changed.png']), fails('55000'));
  await assert.rejects(owner.query('DELETE FROM sample_image_assets WHERE organization_id=$1 AND id=$2', [manager.organizationId, file.id]), fails('55000'));
  await assert.rejects(work(manager, client => client.query('UPDATE sample_image_assets SET original_name=$3 WHERE organization_id=$1 AND id=$2', [manager.organizationId, file.id, 'changed.png'])), fails('42501'));
  await assert.rejects(work(manager, client => client.query(`INSERT INTO sample_image_assets
    SELECT organization_id,$2,original_name,media_type,content,byte_length,sha256,width,height,frame_count,$3,now()
    FROM sample_image_assets WHERE organization_id=$1 AND id=$4`, [manager.organizationId, randomUUID(), reader.userId, file.id])), fails('42501'));
  await assert.rejects(owner.query('UPDATE sample_products SET image_file_id=$3 WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.products[0].id, outside.id]), fails('23503'));
});

test('registration validates every image before mutation and keeps one reference lookup for duplicate images', async () => {
  const file = await upload(); const outside = await upload(foreign);
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const command = { ...fixture.registration, products: [{ ...fixture.registration.products[0], imageFileId: outside.id }] };
  const count = async () => (await owner.query('SELECT count(*) FROM samples WHERE organization_id=$1', [manager.organizationId])).rows[0].count;
  const before = await count();
  await assert.rejects(work(manager, (client, identity) => registerSample(client, identity, command)), fails('invalid_product_image'));
  assert.equal(await count(), before);
  const { sample } = await setup(Array.from({ length: 100 }, () => file));
  let imageQueries = 0;
  const loaded = await work(manager, (client, identity) => loadSample(new Proxy(client, { get(target, property) {
    if (property !== 'query') return Reflect.get(target, property);
    return (...args) => { if (String(args[0]?.text ?? args[0]).includes('FROM sample_image_assets')) imageQueries += 1; return target.query(...args); };
  } }), identity, sample.id));
  assert.equal(imageQueries, 1); assert.equal(loaded.products.length, 100);
  assert(loaded.products.every(line => line.image.id === file.id && line.image.sha256 === file.sha256));
});

test('stable Product lines keep their images through reordering, replacement and removal', async () => {
  const first = await upload(); const second = await upload(); const replacement = await upload();
  let { sample } = await setup([first, second]); const ids = sample.products.map(line => line.id);
  await save(sample, form => { form.products.reverse(); }); sample = await load(sample.id);
  assert.deepEqual(sample.products.map(line => [line.id, line.imageFileId]), [[ids[1], second.id], [ids[0], first.id]]);
  await save(sample, form => { form.products[0].imageFileId = replacement.id; form.products[1].imageFileId = null; }); sample = await load(sample.id);
  assert.equal(sample.products[0].image.id, replacement.id); assert.equal(sample.products[1].image, null);
  assert.deepEqual((await work(reader, (client, identity) => readSampleImage(client, identity, first.id))).content, content);
  assert.deepEqual(sampleEditPayload(sampleEditForm(sample), sample, options), { revision: sample.revision });
});

test('requested tests retain scientific identity during image changes, while stale and unauthorized edits fail', async () => {
  const first = await upload(); const next = await upload(); let { sample } = await setup([first]);
  await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id, {})); sample = await load(sample.id);
  const before = sample.products[0].tests;
  await save(sample, form => { form.products[0].imageFileId = next.id; });
  const saved = await load(sample.id); assert.deepEqual(saved.products[0].tests, before); assert.equal(saved.products[0].image.id, next.id);
  await assert.rejects(save(sample, form => { form.products[0].imageFileId = null; }), fails('sample_changed'));
  await assert.rejects(save(saved, form => { form.products[0].imageFileId = null; }, reader), fails('forbidden'));
});

test('a late sample event failure rolls back the image reference and revision but retains the independently uploaded file', async () => {
  const first = await upload(); const next = await upload(); const { sample } = await setup([first]);
  const form = sampleEditForm(sample); form.products[0].imageFileId = next.id;
  await assert.rejects(work(manager, (client, identity) => updateSample(new Proxy(client, { get(target, property) {
    if (property !== 'query') return Reflect.get(target, property);
    return (...args) => {
      if (/insert into "sample_events"/i.test(String(args[0]?.text ?? args[0]))) throw new Error('Synthetic late image save failure');
      return target.query(...args);
    };
  } }), identity, sample.id, sampleEditPayload(form, sample, options))), error => /Synthetic late/.test(error.message + error.cause?.message));
  const saved = await load(sample.id); assert.deepEqual(saved.products, sample.products); assert.equal(saved.revision, sample.revision); assert.deepEqual(saved.activity, sample.activity);
  assert.deepEqual((await work(reader, (client, identity) => readSampleImage(client, identity, next.id))).content, content);
});

test('sample workflow gates and locked special types also protect image changes', async () => {
  const first = await upload(); const next = await upload();
  for (const settings of [{ editRoleId: reader.roleId }, { editRoleId: manager.roleId, showSampleEdit: false }]) {
    const fixture = await createLaboratoryFixture(owner, manager, { repeated: false, ...settings });
    const created = await work(manager, (client, identity) => registerSample(client, identity, { ...fixture.registration,
      products: [{ ...fixture.registration.products[0], imageFileId: first.id }] }));
    const sample = await load(created.id);
    await assert.rejects(save(sample, form => { form.products[0].imageFileId = next.id; }), fails('workflow_action_denied'));
    assert.deepEqual((await load(created.id)).products, sample.products);
  }
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const created = await work(manager, (client, identity) => registerSample(client, identity, { ...fixture.registration, sampleType: 'quality_control', iqcType: 'retest',
    products: [{ ...fixture.registration.products[0], imageFileId: first.id }] }));
  const sample = await load(created.id);
  await work(manager, (client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products: [{ imageFileId: next.id }] }));
  const saved = await load(sample.id); assert.equal(saved.revision, sample.revision); assert.deepEqual(saved.products, sample.products);
});
