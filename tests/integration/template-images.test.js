import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createImageTemplate } from '../helpers/template-image-fixture.js';
import { animatedPng } from '../helpers/template-images.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { uploadTemplateImage, withTemplateImages } from '../../src/template-assets/service.js';
import { freezeTemplate, createDraft, editTemplate } from '../../src/templates/authoring.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { createCapture, saveCapture, changeRepeat } from '../../src/templates/capture.js';

const owner = ownerPool(); let account;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const fixture = (options) => work((client, identity) => createImageTemplate(client, identity, options));
const definition = (versionId) => work((client, identity) => loadDefinition(client, identity.organization_id, versionId), { readOnly: true });
const upload = (created, input, revision = 1) => work((client, identity) => uploadTemplateImage(client, identity, created.versionId, created.fieldId, revision, input));
const input = async () => ({ requestId: randomUUID(), originalName: 'Synthetic animation.png', mediaType: 'image/png', content: await animatedPng({ separateDefault: true }) });
before(async () => {
  const user = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('template image replacement is atomic, actor-bound and safe to retry after a lost response', async () => {
  const created = await fixture(); const image = await input();
  const attempts = await Promise.all([upload(created, image), upload(created, image)]);
  assert.deepEqual(attempts.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(attempts[0].model.version.revision, 2);
  const stored = (await owner.query('SELECT * FROM template_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, image.requestId])).rows[0];
  assert.equal(stored.uploaded_by, account.userId); assert.ok(stored.uploaded_at instanceof Date);
  assert.equal(stored.frame_count, 2); assert.ok(stored.content.equals(image.content));
  const firstPixel = await sharp(stored.print_content).removeAlpha().raw().toBuffer();
  assert.deepEqual([...firstPixel.subarray(0, 3)], [255, 0, 0]);
  await assert.rejects(upload(created, { ...image, originalName: 'Reused.png' }), { code: 'image_request_reused' });
  const replacement = await input();
  await assert.rejects(upload(created, replacement), { code: 'stale_template' });
  await assert.rejects(upload(created, { ...replacement, content: Buffer.from('bad image') }, 2), { code: 'invalid_template_image' });
  assert.equal((await definition(created.versionId)).model.version.revision, 2);
  assert.equal((await owner.query('SELECT id FROM template_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, replacement.requestId])).rowCount, 0);
  await upload(created, replacement, 2);
  await assert.rejects(upload(created, image), { code: 'stale_template' });
  assert.equal((await owner.query('SELECT count(*)::int n FROM template_image_assets WHERE organization_id=$1 AND id=ANY($2::uuid[])', [account.organizationId, [image.requestId, replacement.requestId]])).rows[0].n, 2);
  const registrar = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.create'] });
  const session = await signIn({ identifier: registrar.username, password: registrar.password });
  const visible = await withSession(session.token, (client) => client.query('SELECT id FROM template_image_assets WHERE id=ANY($1::uuid[])', [[image.requestId, replacement.requestId]]), { readOnly: true });
  assert.deepEqual(visible.rows, [{ id: replacement.requestId }]);
});

test('frozen captures, runtime snapshots, draft clones and layout clones retain exact image references', async () => {
  const created = await fixture({ repeated: true }); const image = await input(); await upload(created, image);
  const snapshotId = await work(async (client) => (await client.query('SELECT template_snapshot_from_draft($1,$2) AS id', [created.versionId, 2])).rows[0].id);
  const frozen = await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  const capture = await work((client, identity) => createCapture(client, identity, created.versionId));
  const historical = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId), { readOnly: true });
  assert.equal(historical.metrics.queryCount, 3); assert.equal(historical.values.length, 2);
  assert.ok(historical.values.every((value) => value.valueType === 'image' && value.origin === 'default' && value.imageId === image.requestId));
  const draft = await work((client, identity) => createDraft(client, identity, frozen.versionId));
  const nextImage = { ...await input(), content: await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer() };
  await upload({ ...created, versionId: draft.versionId }, nextImage);
  let cloned = await work((client, identity) => editTemplate(client, identity, draft.versionId, 2, { type: 'clone', kind: 'row', id: created.rowId }));
  assert.equal(Object.values(cloned.model.fieldsById).length, 2);
  assert.ok(Object.values(cloned.model.fieldsById).every((field) => field.defaultImageId === nextImage.requestId && field.image.fieldId === field.id && field.image.widthPercent === 50));
  const cloneId = Object.values(cloned.model.fieldsById).find((field) => field.id !== created.fieldId).id;
  cloned = await work((client, identity) => editTemplate(client, identity, draft.versionId, 3, { type: 'delete', kind: 'field', id: cloneId }));
  assert.equal(Object.values(cloned.model.fieldsById).length, 1);
  for (const versionId of [created.versionId, snapshotId]) assert.equal((await definition(versionId)).model.fieldsById[created.fieldId].defaultImageId, image.requestId);
  assert.deepEqual((await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId, 1), { readOnly: true })).values, historical.values);
  await assert.rejects(work((client, identity) => saveCapture(client, identity, capture.instanceId, 1, [{ fieldId: created.fieldId, occurrenceId: historical.values[0].occurrenceId, state: 'present', value: nextImage.requestId }])), { code: 'readonly_field' });
});

test('runtime repeat clones preserve immutable image defaults with and without copied data', async () => {
  const created = await fixture({ repeated: true }); const image = await input(); await upload(created, image);
  await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  const capture = await work((client, identity) => createCapture(client, identity, created.versionId));
  const original = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const occurrenceId = original.values[0].occurrenceId; let current = original;
  for (const withData of [false, true]) {
    current = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, current.revision, { type: 'clone', occurrenceId, withData }));
    assert.ok(current.values.every((value) => value.origin === 'default' && value.imageId === image.requestId));
  }
  assert.equal(current.values.length, 4);
  const reloaded = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  assert.equal(reloaded.values.length, 4); assert.ok(reloaded.values.every((value) => value.origin === 'default' && value.imageId === image.requestId));
  assert.deepEqual((await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId, 1))).values, original.values);
});

test('image configuration uses source layout values and remains immutable in frozen versions', async () => {
  const created = await fixture();
  const configured = await work((client, identity) => editTemplate(client, identity, created.versionId, 1, { type: 'configureField', columnId: created.columnId,
    widget: 'template_image_widget', alias: 'configured_image', image: { widthPercent: '-25%', marginTop: '0', marginRight: '-2.5px', alignment: 'middle' } }));
  const field = configured.model.fieldsById[created.fieldId];
  assert.equal(field.image.widthPercent, -25); assert.equal(field.image.marginRight, -2.5); assert.equal(field.image.alignment, 'center');
  await assert.rejects(work((client, identity) => editTemplate(client, identity, created.versionId, 2, { type: 'configureField', columnId: created.columnId,
    widget: 'template_image_widget', alias: 'configured_image', editable: true })), { code: 'readonly_image_widget' });
  await assert.rejects(work((client) => client.query('DELETE FROM template_image_config WHERE organization_id=$1 AND version_id=$2', [account.organizationId, created.versionId])), { code: '23514' });
  await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  await assert.rejects(owner.query('UPDATE template_image_config SET margin_top=2 WHERE organization_id=$1 AND version_id=$2', [account.organizationId, created.versionId]), { code: '55000' });
});

test('image read/write policies, immutable bytes, tenant foreign keys and direct capture writes enforce boundaries', async () => {
  const created = await fixture(); const image = await input(); await upload(created, image);
  assert.equal((await getPool().query('SELECT id FROM template_image_assets')).rowCount, 0);
  for (const [sameOrganization, permissions] of [[true, ['templates.read']], [true, ['samples.create']], [true, []], [false, ['templates.read', 'templates.manage']]]) {
    const user = await createAccount(owner, { organizationId: sameOrganization ? account.organizationId : undefined, permissions });
    const session = await signIn({ identifier: user.username, password: user.password });
    const run = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
    assert.equal((await run((client) => client.query('SELECT id FROM template_image_assets WHERE id=$1', [image.requestId]))).rowCount, sameOrganization && permissions.length ? 1 : 0);
    await assert.rejects(run((client, identity) => uploadTemplateImage(client, identity, created.versionId, created.fieldId, 2, image)), { code: sameOrganization ? 'forbidden' : 'template_image_field_not_found' });
  }
  await assert.rejects(owner.query('UPDATE template_image_assets SET original_name=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, image.requestId, 'changed.png']), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM template_image_assets WHERE organization_id=$1 AND id=$2', [account.organizationId, image.requestId]), { code: '55000' });
  await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  const capture = await work((client, identity) => createCapture(client, identity, created.versionId));
  const original = (await owner.query('SELECT * FROM template_values WHERE organization_id=$1 AND instance_id=$2', [account.organizationId, capture.instanceId])).rows[0];
  await assert.rejects(owner.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,image_id,saved_by)
    VALUES($1,$2,$3,$4,$5,1,'image','present','entered',$6,$7)`, [account.organizationId, capture.instanceId, created.versionId, created.fieldId, original.occurrence_id, image.requestId, account.userId]), { code: '23514' });
  const second = await fixture();
  await assert.rejects(work((client) => client.query("UPDATE template_fields SET default_state='present',default_image_id=$3 WHERE organization_id=$1 AND version_id=$2", [account.organizationId, second.versionId, randomUUID()])), { code: '23503' });
});

test('definition and capture image reads use one counted batch and reject excessive expanded repetitions', async () => {
  const created = await fixture({ repeated: true }); const image = { ...await input(), content: await sharp(randomBytes(128 * 128 * 3), { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer() }; await upload(created, image);
  await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  const capture = await work((client, identity) => createCapture(client, identity, created.versionId));
  await work(async (client, identity) => {
    let calls = 0; const counted = { query: (...args) => { calls++; return client.query(...args); } };
    const definition = await loadDefinition(counted, identity.organization_id, created.versionId);
    const runtime = await loadCapture(counted, identity.organization_id, capture.instanceId);
    const rendered = await withTemplateImages(counted, identity.organization_id, definition, runtime);
    assert.equal(calls, 12); assert.equal(rendered.metrics.queryCount, 8); assert.equal(rendered.metrics.assets.queryCount, 1);
    assert.equal(Object.keys(rendered.model.imageSources).length, 1);
    assert.equal(rendered.metrics.assets.images, 1);
    const largeSources = { ...definition, model: { ...definition.model, fieldsById: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [index, definition.model.fieldsById[created.fieldId]])) } };
    await assert.rejects(withTemplateImages(client, identity.organization_id, largeSources), { code: 'template_image_batch_size_limit' });
  }, { readOnly: true });
});

async function boundaryFixture(overflow = false) {
  const created = await fixture({ repeated: true });
  const image = { ...await input(), content: await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer() };
  const loaded = await upload(created, image); const sources = loaded.model.imageSources[image.requestId];
  const limit = Math.floor(32 * 1024 * 1024 / (sources.src.length + sources.printSrc.length));
  assert.ok(limit > 2 && limit < 1000);
  await work((client) => client.query('UPDATE template_repeat_groups SET minimum=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, created.groupId, overflow ? limit + 1 : 2]));
  await work((client, identity) => freezeTemplate(client, identity, created.versionId, 2));
  return { ...created, limit, image };
}

test('capture initialization rejects excessive image repeats without persisting an unusable instance', async () => {
  const created = await boundaryFixture(true);
  await assert.rejects(work((client, identity) => createCapture(client, identity, created.versionId)), { code: 'template_image_batch_size_limit' });
  assert.equal((await owner.query('SELECT count(*)::int n FROM template_instances WHERE organization_id=$1 AND version_id=$2', [account.organizationId, created.versionId])).rows[0].n, 0);
});

test('image repeat limits reject both clone modes atomically and permit deleting then restoring a row', async () => {
  const created = await boundaryFixture();
  const capture = await work((client, identity) => createCapture(client, identity, created.versionId));
  const original = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const occurrenceId = original.values[0].occurrenceId;
  let current = original;
  while (current.values.length < created.limit) current = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, current.revision, { type: 'clone', occurrenceId, withData: true }));
  const boundary = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const loaded = await definition(created.versionId);
  const rendered = await work((client, identity) => withTemplateImages(client, identity.organization_id, loaded, boundary));
  assert.equal(boundary.values.length, created.limit); assert.ok(rendered.metrics.assets.renderedBytes <= 32 * 1024 * 1024);
  for (const withData of [false, true]) {
    await assert.rejects(work((client, identity) => changeRepeat(client, identity, capture.instanceId, boundary.revision, { type: 'clone', occurrenceId, withData })), { code: 'template_image_batch_size_limit' });
    const unchanged = await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
    assert.equal(unchanged.revision, boundary.revision); assert.deepEqual(unchanged.occurrences, boundary.occurrences); assert.deepEqual(unchanged.values, boundary.values);
  }
  const removed = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, boundary.revision, { type: 'remove', occurrenceId }));
  const restored = await work((client, identity) => changeRepeat(client, identity, capture.instanceId, removed.revision,
    { type: 'clone', occurrenceId: removed.occurrences.find((row) => row.groupId).id, withData: true }));
  assert.equal(restored.values.length, created.limit); assert.ok(restored.values.every((value) => value.imageId === created.image.requestId && value.origin === 'default'));
  assert.deepEqual((await work((client, identity) => loadCapture(client, identity.organization_id, capture.instanceId, 1))).values, original.values);
});
