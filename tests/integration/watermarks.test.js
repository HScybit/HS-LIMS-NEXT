import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadReportImage, readReportImage } from '../../src/report-assets/images.js';
import { saveWatermark, loadWatermark, listWatermarks, deleteWatermark } from '../../src/report-assets/watermarks.js';

const owner = ownerPool(); let account; let image; let content;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const input = (changes = {}) => ({ watermarkId: randomUUID(), requestId: randomUUID(), revision: 0, name: `Watermark ${randomUUID()}`,
  imageId: image.id, opacity: 0.5, width: 240, height: 320, rotation: 0, ...changes });
const sqlSave = (client, value, retired = false) => client.query('SELECT * FROM report_save_watermark($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [value.watermarkId, value.requestId, value.revision, value.name, value.imageId, value.opacity, value.width, value.height, value.rotation, retired]);
before(async () => {
  const user = await createAccount(owner, { permissions: ['report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  content = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#005577' } }).png().toBuffer();
  image = await work((client, identity) => uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Watermark.png', mediaType: 'image/png', content }));
});
after(async () => { await closePool(); await owner.end(); });

test('watermark revisions retain zero settings, original image bytes and actual actors after replacement and retirement', async () => {
  const value = input({ opacity: 0, rotation: 0, width: 1, height: 10_000 });
  const first = await work(async (client, identity) => {
    const saved = await saveWatermark(client, identity, value);
    const evidence = (await client.query('SELECT transaction_id=pg_current_xact_id() AND saved_at=now() AS actual FROM report_watermark_versions WHERE organization_id=$1 AND id=$2', [account.organizationId, value.requestId])).rows[0];
    assert.equal(evidence.actual, true); return saved.watermark;
  });
  assert.equal(first.opacity, 0); assert.equal(first.rotation, 0); assert.equal(first.width, 1); assert.equal(first.height, 10_000);
  assert.equal(first.createdBy, account.userId); assert.equal(first.savedBy, account.userId);
  const replacement = await work((client, identity) => uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Replacement.png', mediaType: 'image/png', content }));
  const second = await work((client, identity) => saveWatermark(client, identity, { ...value, requestId: randomUUID(), revision: 1,
    imageId: replacement.id, opacity: 1, rotation: 360, width: 10_000, height: 1 }));
  assert.equal(second.watermark.revision, 2); assert.equal(second.watermark.createdAt.getTime(), first.createdAt.getTime());
  const deletion = { requestId: randomUUID(), revision: 2 };
  const removed = await work((client, identity) => deleteWatermark(client, identity, value.watermarkId, deletion));
  assert.equal(removed.watermark.revision, 3); assert.equal(removed.watermark.isRetired, true); assert.equal(removed.watermark.rotation, 360);
  assert.equal((await work((client, identity) => deleteWatermark(client, identity, value.watermarkId, deletion))).replayed, true);
  await assert.rejects(work((client, identity) => loadWatermark(client, identity, value.watermarkId)), { code: 'watermark_not_found' });
  const original = await work((client, identity) => loadWatermark(client, identity, value.watermarkId, { versionId: first.versionId }), { readOnly: true });
  assert.deepEqual(original, first);
  assert.deepEqual((await work((client, identity) => readReportImage(client, identity, image.id), { readOnly: true })).content, content);
  await assert.rejects(work((client, identity) => saveWatermark(client, identity, { ...value, requestId: randomUUID(), revision: 3 })), { code: 'watermark_retired' });
  await assert.rejects(owner.query('UPDATE report_watermark_versions SET opacity=0.9 WHERE organization_id=$1 AND id=$2', [account.organizationId, first.versionId]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM report_watermarks WHERE organization_id=$1 AND id=$2', [account.organizationId, value.watermarkId]), { code: '55000' });
});

test('watermark retries save once, competing edits reject stale revisions, and old request replay preserves its exact version', async () => {
  const value = input();
  const saved = await Promise.all([1, 2].map(() => work((client, identity) => saveWatermark(client, identity, value))));
  assert.equal(saved.filter((result) => result.replayed).length, 1); assert.deepEqual(saved[0].watermark, saved[1].watermark);
  await assert.rejects(work((client, identity) => saveWatermark(client, identity, { ...value, opacity: 0 })), { code: 'watermark_request_reused' });
  const edits = await Promise.allSettled(['A', 'B'].map((name) => work((client, identity) => saveWatermark(client, identity, { ...value, name, revision: 1, requestId: randomUUID() }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_watermark');
  const original = await work((client, identity) => saveWatermark(client, identity, value));
  assert.equal(original.replayed, true); assert.equal(original.watermark.revision, 1); assert.equal(original.watermark.name, value.name);
  await assert.rejects(work((client, identity) => deleteWatermark(client, identity, value.watermarkId, { revision: 1, requestId: randomUUID() })), { code: 'stale_watermark' });
});

test('concurrent save request reuse across different watermarks cannot create a second identity', async () => {
  const a = input(); const b = input({ requestId: a.requestId });
  const results = await Promise.allSettled([a, b].map((value) => work((client, identity) => saveWatermark(client, identity, value))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'watermark_request_reused');
  assert.equal((await owner.query('SELECT id FROM report_watermarks WHERE organization_id=$1 AND id=ANY($2::uuid[])', [account.organizationId, [a.watermarkId, b.watermarkId]])).rowCount, 1);
});

test('watermark list uses the latest name, literal search, date filters, deterministic pages and correct totals on empty pages', async () => {
  const marker = `Search %_\\ ${randomUUID()}`;
  const a = input({ name: `${marker} A` }); const b = input({ name: `${marker} B` });
  await Promise.all([a, b].map((value) => work((client, identity) => saveWatermark(client, identity, value))));
  const today = new Date().toISOString().slice(0, 10);
  const query = { search: marker, pageSize: 1, sort: { key: 'name', dir: 'asc' }, filters: { created_at: { type: 'date', from: today, to: today } } };
  const page = await work((client, identity) => listWatermarks(client, identity, query), { readOnly: true });
  assert.equal(page.totalCount, 2); assert.equal(page.rows[0]._id, a.watermarkId);
  const next = await work((client, identity) => listWatermarks(client, identity, { ...query, page: 2 }));
  assert.equal(next.rows[0]._id, b.watermarkId);
  const emptyPage = await work((client, identity) => listWatermarks(client, identity, { ...query, page: 99 }));
  assert.equal(emptyPage.totalCount, 2); assert.deepEqual(emptyPage.rows, []);
  await work((client, identity) => saveWatermark(client, identity, { ...a, requestId: randomUUID(), revision: 1, name: 'Renamed' }));
  const remaining = await work((client, identity) => listWatermarks(client, identity, { filters: { name: { type: 'text', value: marker } } }));
  assert.equal(remaining.totalCount, 1); assert.equal(remaining.rows[0]._id, b.watermarkId);
  await work((client, identity) => deleteWatermark(client, identity, b.watermarkId, { requestId: randomUUID(), revision: 1 }));
  assert.equal((await work((client, identity) => listWatermarks(client, identity, query))).totalCount, 0);
  for (const invalid of [null, { sort: { key: 'name;DROP TABLE report_watermarks', dir: 'asc' } }, { filters: { created_at: { type: 'date', from: '2026-02-30' } } }, { filters: { opacity: { type: 'text', value: '0' } } }, { page: 0 }, { pageSize: 101 }]) {
    await assert.rejects(work((client, identity) => listWatermarks(client, identity, invalid)), (error) => error.status === 400);
  }
});

test('missing images, invalid typed settings and interrupted saves leave no partial watermark identity', async () => {
  for (const changes of [{ opacity: null }, { opacity: '' }, { opacity: '0.5' }, { opacity: NaN }, { opacity: Infinity }, { opacity: -0.1 }, { opacity: 1.1 },
    { rotation: 45 }, { rotation: '90' }, { rotation: 450 }, { width: 0 }, { width: 10_001 }, { height: 2.5 }, { height: null }, { name: ' ' }, { imageId: null }, { savedBy: account.userId }]) {
    await assert.rejects(work((client, identity) => saveWatermark(client, identity, input(changes))), (error) => error.status === 400);
  }
  const missing = input({ imageId: randomUUID() });
  await assert.rejects(work((client, identity) => saveWatermark(client, identity, missing)), { code: 'watermark_image' });
  assert.equal((await owner.query('SELECT id FROM report_watermarks WHERE organization_id=$1 AND id=$2', [account.organizationId, missing.watermarkId])).rowCount, 0);
  const interrupted = input();
  await assert.rejects(work(async (client, identity) => { await saveWatermark(client, identity, interrupted); throw new Error('Synthetic interruption'); }), /Synthetic interruption/);
  assert.equal((await owner.query('SELECT id FROM report_watermarks WHERE organization_id=$1 AND id=$2', [account.organizationId, interrupted.watermarkId])).rowCount, 0);
  assert.equal((await work((client, identity) => saveWatermark(client, identity, interrupted))).replayed, false);
  for (const changes of [{ opacity: null }, { opacity: 'NaN' }, { opacity: 'Infinity' }, { width: 0 }, { height: 10_001 }, { rotation: 45 }, { name: null }, { revision: null }]) {
    await assert.rejects(work((client) => sqlSave(client, input(changes))), { constraint: 'report_watermark_input' });
  }
  await assert.rejects(work((client) => sqlSave(client, { ...interrupted, requestId: randomUUID(), revision: 1, name: 'Altered during delete' }, true)), { constraint: 'report_watermark_input' });
});

test('watermark permission and tenant boundaries apply to reads, narrow commands, actor replay and direct database writes', async () => {
  const value = input(); await work((client, identity) => saveWatermark(client, identity, value));
  for (const options of [{ organizationId: account.organizationId, permissions: ['report_settings.read'] }, { organizationId: account.organizationId, permissions: ['report_settings.manage'] },
    { permissions: ['report_settings.manage'] }, { organizationId: account.organizationId, permissions: ['templates.read'] }]) {
    const user = await createAccount(owner, options); const session = await signIn({ identifier: user.username, password: user.password });
    const run = (callback) => withSession(session.token, callback, { csrfToken: session.csrfToken });
    if (options.permissions[0] === 'templates.read') {
      await assert.rejects(run((client, identity) => loadWatermark(client, identity, value.watermarkId)), { code: 'forbidden' });
      assert.equal((await run((client) => client.query('SELECT id FROM report_watermarks'))).rowCount, 0);
    } else if (user.organizationId !== account.organizationId) {
      await assert.rejects(run((client, identity) => loadWatermark(client, identity, value.watermarkId)), { code: 'watermark_not_found' });
      assert.equal((await run((client) => client.query('SELECT id FROM report_watermark_versions WHERE watermark_id=$1', [value.watermarkId]))).rowCount, 0);
      await assert.rejects(run((client, identity) => saveWatermark(client, identity, input())), { code: 'watermark_image' });
    } else if (options.permissions[0] === 'report_settings.read') {
      assert.equal((await run((client, identity) => loadWatermark(client, identity, value.watermarkId))).id, value.watermarkId);
      await assert.rejects(run((client, identity) => saveWatermark(client, identity, input())), { code: 'forbidden' });
      await assert.rejects(run((client, identity) => deleteWatermark(client, identity, value.watermarkId, { requestId: randomUUID(), revision: 1 })), { code: 'forbidden' });
      await assert.rejects(run((client) => sqlSave(client, input())), { code: '42501' });
    } else {
      await assert.rejects(run((client, identity) => saveWatermark(client, identity, value)), { code: 'watermark_request_reused' });
      const edit = await run((client, identity) => saveWatermark(client, identity, { ...value, requestId: randomUUID(), revision: 1 }));
      assert.equal(edit.watermark.savedBy, user.userId); assert.equal(edit.watermark.createdBy, account.userId);
    }
  }
  await assert.rejects(work((client) => client.query('INSERT INTO report_watermarks(organization_id,id,created_by) VALUES($1,$2,$3)', [account.organizationId, randomUUID(), account.userId])), { code: '42501' });
  const privileges = (await owner.query("SELECT has_table_privilege('sampleify_report_worker','report_watermark_versions','SELECT') AS worker_read,has_function_privilege('sampleify_report_worker','report_save_watermark(uuid,uuid,integer,text,uuid,numeric,integer,integer,integer,boolean)','EXECUTE') AS worker_save")).rows[0];
  assert.deepEqual(privileges, { worker_read: false, worker_save: false });
});
