import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveReportDocument, loadReportDocument, listReportDocuments, deleteReportDocument } from '../../src/report-assets/documents.js';
import { uploadReportImage } from '../../src/report-assets/images.js';

const owner = ownerPool(); let account; let image;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const input = (changes = {}) => ({ documentId: randomUUID(), requestId: randomUUID(), revision: 0, type: 'header', name: `Header ${randomUUID()}`,
  templateHtml: `<p style="text-align:center"><strong>Laboratory &amp; Results</strong><img src="${image.url}" alt="Lab logo" width="32" /></p>`, isDefault: false, ...changes });
before(async () => {
  const user = await createAccount(owner, { permissions: ['report_settings.read', 'report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const content = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#005577' } }).png().toBuffer();
  image = await work((client, identity) => uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Logo.png', mediaType: 'image/png', content }));
});
after(async () => { await closePool(); await owner.end(); });

test('source header/footer saves create immutable content/image versions and preserve history after edits and deletion', async () => {
  const value = input({ isDefault: true });
  const first = await work((client, identity) => saveReportDocument(client, identity, value));
  assert.equal(first.document.revision, 1); assert.equal(first.document.isDefault, true);
  assert.deepEqual(first.document.imageIds, [image.id]); assert.equal(first.document.savedBy, account.userId);
  const second = await work((client, identity) => saveReportDocument(client, identity, { ...value, requestId: randomUUID(), revision: 1,
    name: 'Updated header', templateHtml: '<p>New printed address</p>' }));
  assert.equal(second.document.revision, 2); assert.deepEqual(second.document.imageIds, []);
  const historical = await work((client, identity) => loadReportDocument(client, identity, value.documentId, { versionId: first.document.versionId }), { readOnly: true });
  assert.equal(historical.templateHtml, first.document.templateHtml); assert.deepEqual(historical.imageIds, [image.id]);
  const deletion = { requestId: randomUUID(), revision: 2 };
  const removed = await work((client, identity) => deleteReportDocument(client, identity, value.documentId, deletion));
  assert.equal(removed.document.isRetired, true); assert.equal(removed.document.isDefault, false); assert.equal(removed.document.revision, 3);
  assert.equal((await work((client, identity) => deleteReportDocument(client, identity, value.documentId, deletion))).replayed, true);
  await assert.rejects(work((client, identity) => loadReportDocument(client, identity, value.documentId)), { code: 'report_document_not_found' });
  const old = await work((client, identity) => loadReportDocument(client, identity, value.documentId, { versionId: first.document.versionId }));
  assert.equal(old.templateHtml, first.document.templateHtml);
  await assert.rejects(owner.query('UPDATE report_document_versions SET template_html=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, first.document.versionId, 'Changed']), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM report_document_images WHERE organization_id=$1 AND version_id=$2', [account.organizationId, first.document.versionId]), { code: '55000' });
  await assert.rejects(owner.query('INSERT INTO report_document_images(organization_id,version_id,image_id) VALUES($1,$2,$3)', [account.organizationId, second.document.versionId, image.id]), { code: '23514' });
});

test('concurrent retries save once, changed requests fail, and stale edits cannot replace a newer version', async () => {
  const value = input();
  const first = await Promise.all([1, 2].map(() => work((client, identity) => saveReportDocument(client, identity, value))));
  assert.equal(first.filter((result) => result.replayed).length, 1); assert.equal(first[0].document.versionId, first[1].document.versionId);
  await assert.rejects(work((client, identity) => saveReportDocument(client, identity, { ...value, name: 'Different' })), { code: 'report_document_request_reused' });
  const edits = await Promise.allSettled(['A', 'B'].map((name) => work((client, identity) => saveReportDocument(client, identity, { ...value, name, requestId: randomUUID(), revision: 1 }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_report_document');
  assert.equal((await work((client, identity) => loadReportDocument(client, identity, value.documentId))).revision, 2);
  assert.equal((await work((client, identity) => saveReportDocument(client, identity, value))).replayed, true);
});

test('default switching, search, empty pages and footer separation follow the current active version', async () => {
  const marker = `Lookup ${randomUUID()}`;
  const a = input({ name: `${marker} A`, isDefault: true }); const b = input({ name: `${marker} B`, isDefault: true });
  const saved = await Promise.all([a, b].map((value) => work((client, identity) => saveReportDocument(client, identity, value))));
  const list = await work((client, identity) => listReportDocuments(client, identity, { type: 'header', query: marker, pageSize: 1, page: 99 }), { readOnly: true });
  assert.equal(list.filteredTotal, 2); assert.equal(list.page, 2); assert.equal(list.items.length, 1);
  const current = await Promise.all(saved.map((result) => work((client, identity) => loadReportDocument(client, identity, result.document.id))));
  assert.equal(current.filter((document) => document.isDefault).length, 1);
  assert.equal(list.defaultHeader.id, current.find((document) => document.isDefault).id);
  const footer = await work((client, identity) => saveReportDocument(client, identity, input({ type: 'footer', name: marker, templateHtml: '<p>Page footer</p>' })));
  assert.equal(footer.document.isDefault, false);
  const footers = await work((client, identity) => listReportDocuments(client, identity, { type: 'footer', query: marker }));
  assert.deepEqual(footers.items.map((document) => document.id), [footer.document.id]);
  const empty = await work((client, identity) => listReportDocuments(client, identity, { type: 'header', query: randomUUID(), page: 10 }));
  assert.equal(empty.page, 1); assert.equal(empty.filteredTotal, 0); assert.deepEqual(empty.items, []);
  await assert.rejects(work((client, identity) => saveReportDocument(client, identity, input({ type: 'footer', isDefault: true }))), { code: 'invalid_default_header' });
});

test('unavailable images, unsafe markup and interrupted saves roll back without creating partial versions or defaults', async () => {
  await assert.rejects(work((client, identity) => saveReportDocument(client, identity, input({ templateHtml: `<p><img src="/api/report-assets/images/${randomUUID()}"></p>` }))), { code: 'report_document_images' });
  await assert.rejects(work((client, identity) => saveReportDocument(client, identity, input({ templateHtml: '<p onclick="alert(1)">Unsafe</p>' }))), { code: 'unsafe_report_html' });
  await assert.rejects(work((client, identity) => saveReportDocument(client, identity, input({ templateHtml: null }))), { code: 'invalid_report_html' });
  const value = input({ isDefault: true });
  await assert.rejects(work(async (client, identity) => { await saveReportDocument(client, identity, value); throw new Error('Synthetic save interruption'); }), /Synthetic save interruption/);
  assert.equal((await owner.query('SELECT id FROM report_documents WHERE organization_id=$1 AND id=$2', [account.organizationId, value.documentId])).rowCount, 0);
  assert.equal((await work((client, identity) => saveReportDocument(client, identity, value))).replayed, false);
});

test('report settings permissions and tenant references protect document commands and stored history', async () => {
  const value = input(); await work((client, identity) => saveReportDocument(client, identity, value));
  for (const options of [{ organizationId: account.organizationId, permissions: ['report_settings.read'] }, { permissions: ['report_settings.manage'] }]) {
    const user = await createAccount(owner, options); const session = await signIn({ identifier: user.username, password: user.password });
    const run = (callback) => withSession(session.token, callback, { csrfToken: session.csrfToken });
    if (user.organizationId === account.organizationId) {
      assert.equal((await run((client, identity) => loadReportDocument(client, identity, value.documentId))).id, value.documentId);
      await assert.rejects(run((client, identity) => saveReportDocument(client, identity, input())), { code: 'forbidden' });
      await assert.rejects(run((client) => client.query('SELECT * FROM report_save_document($1,$2,0,$3,$4,$5,false,false,$6)', [randomUUID(), randomUUID(), 'header', 'Denied', '', []])), { code: '42501' });
    } else {
      await assert.rejects(run((client, identity) => loadReportDocument(client, identity, value.documentId)), { code: 'report_document_not_found' });
      assert.equal((await run((client) => client.query('SELECT id FROM report_document_versions WHERE document_id=$1', [value.documentId]))).rowCount, 0);
      await assert.rejects(run((client, identity) => saveReportDocument(client, identity, input())), { code: 'report_document_images' });
    }
  }
  await assert.rejects(work((client) => client.query('INSERT INTO report_documents(organization_id,id,type,created_by) VALUES($1,$2,$3,$4)', [account.organizationId, randomUUID(), 'header', account.userId])), { code: '42501' });
});
