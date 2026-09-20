import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { createReportAssets } from '../helpers/report-assets.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate, createDraft } from '../../src/templates/authoring.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { saveReportDocument, deleteReportDocument, loadReportDocument } from '../../src/report-assets/documents.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';
import { pdfPageText } from '../helpers/pdf-page-text.js';
import { reportSvg } from '../helpers/report-svg.js';
import { uploadReportImage } from '../../src/report-assets/images.js';

const owner = ownerPool(); let account; let worker;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  process.loadEnvFile('.env.worker.local'); worker = createReportWorkerPool();
});
after(async () => { await worker.end(); await closePool(); await owner.end(); });

test('report generation pins exact content/image versions, preserves explicit empty selections, and copies bindings into runtime snapshots and new drafts', async () => {
  const flow = await prepareReportFlow(owner, account);
  const assets = await work(createReportAssets);
  const configured = await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  assert.equal(configured.model.version.revision, 2);
  const first = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const original = await work((client, identity) => loadReport(client, identity, first.items[0].id), { readOnly: true });
  assert.equal(original.model.version.headerDocumentId, assets.header.id);
  assert.equal(original.assets.header.versionId, assets.header.versionId);
  assert.match(original.assets.header.html, /FROZEN LABORATORY HEADER/);
  assert.ok(original.assets.header.html.includes(`data:image/png;base64,${assets.content.toString('base64')}`));
  assert.equal(original.metrics.definition.queryCount, 9); assert.equal(original.metrics.assets.queryCount, 1);
  assert.equal(original.metrics.assets.rows, 3);
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, first.items[0].id.toUpperCase()), { readOnly: true })).assets, original.assets);
  const changed = await work((client, identity) => saveReportDocument(client, identity, { ...assets.headerInput, requestId: randomUUID(), revision: 1, templateHtml: '<p>NEW LABORATORY HEADER</p>' }));
  const second = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  const current = await work((client, identity) => loadReport(client, identity, second.items[0].id), { readOnly: true });
  assert.equal(current.assets.header.versionId, changed.document.versionId); assert.match(current.assets.header.html, /NEW LABORATORY HEADER/);
  assert.equal(current.model.version.id, original.model.version.id);
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, first.items[0].id), { readOnly: true })).assets, original.assets);
  await work((client, identity) => deleteReportDocument(client, identity, assets.header.id, { revision: 2, requestId: randomUUID() }));
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, first.items[0].id), { readOnly: true })).assets, original.assets);
  await assert.rejects(owner.query('UPDATE sample_report_assets SET header_version_id=NULL WHERE organization_id=$1 AND report_id=$2', [account.organizationId, first.items[0].id]), { code: '55000' });
  await assert.rejects(work((client) => client.query('INSERT INTO sample_report_assets(organization_id,report_id) VALUES($1,$2)', [account.organizationId, first.items[0].id])), { code: '42501' });
  const failedId = randomUUID();
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: failedId })), (error) => error.constraint === 'report_asset_unavailable' || error.code === 'report_asset_unavailable');
  assert.equal((await owner.query('SELECT id FROM sample_events WHERE organization_id=$1 AND id=$2', [account.organizationId, failedId])).rowCount, 0);
  const cleared = await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 2,
    { type: 'setReportAssets', headerDocumentId: null, footerDocumentId: null, nablHeaderDocumentId: null, nablFooterDocumentId: null }));
  assert.equal(cleared.model.version.revision, 3);
  const empty = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, empty.items[0].id))).assets, {});
  // A controlled draft made from a frozen version retains its selected identity,
  // even if that asset has since been retired and needs explicit replacement.
  await owner.query("UPDATE template_versions SET status='frozen',revision=revision+1,frozen_at=now(),frozen_by=$3 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.template.versionId, account.userId]);
  const draft = await work((client, identity) => createDraft(client, identity, original.model.version.id));
  const selected = (await owner.query('SELECT header_document_id FROM template_versions WHERE organization_id=$1 AND id=$2', [account.organizationId, draft.versionId])).rows[0];
  assert.equal(selected.header_document_id, assets.header.id);
});

test('header/footer bindings reject stale edits, wrong types and foreign identities without changing template revision', async () => {
  const flow = await prepareReportFlow(owner, account); const assets = await work(createReportAssets);
  await assert.rejects(work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, { ...assets.command, headerDocumentId: assets.footer.id })), { code: 'report_asset_unavailable' });
  await assert.rejects(work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, { ...assets.command, headerDocumentId: randomUUID() })), { code: 'report_asset_unavailable' });
  const configured = await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command)); assert.equal(configured.model.version.revision, 2);
  await assert.rejects(work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command)), { code: 'stale_template' });
  await assert.rejects(work((client) => client.query('UPDATE template_versions SET revision=revision+1,header_document_id=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, flow.template.versionId, assets.footer.id])), { constraint: 'template_report_asset_type' });
});

test('grouped generation validates captured assets in one read and rolls back every report when that validation fails', async () => {
  const flow = await prepareReportFlow(owner, account, { productLines: 2 }); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const products = (await owner.query('SELECT id FROM sample_products WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [account.organizationId, flow.sample.id])).rows;
  const input = { ...flow.input, finalizeSample: true, reportType: 'product_wise', templateSelections: products.map((product) => ({ key: product.id, templateId: flow.template.templateId })) };
  let reads = 0;
  await assert.rejects(work((client, identity) => generateReports({ query: (statement, parameters) => {
    if (typeof statement === 'string' && statement.startsWith('WITH selected AS (')) { reads += 1; throw new Error('Synthetic captured asset failure'); }
    return client.query(statement, parameters);
  } }, identity, flow.sample.id, input)), /Synthetic captured asset failure/);
  assert.equal(reads, 1);
  assert.equal((await owner.query('SELECT id FROM sample_reports WHERE organization_id=$1 AND generated_event_id=$2', [account.organizationId, input.requestId])).rowCount, 0);
  assert.deepEqual((await owner.query('SELECT status,revision FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, flow.sample.id])).rows[0], { status: 'registered', revision: 1 });
  reads = 0;
  const generated = await work((client, identity) => generateReports({ query: (statement, parameters) => {
    if (typeof statement === 'string' && statement.startsWith('WITH selected AS (')) reads += 1;
    return client.query(statement, parameters);
  } }, identity, flow.sample.id, input));
  assert.equal(generated.items.length, 2); assert.equal(reads, 1); assert.equal(generated.sample.status, 'completed');
});

test('a concurrent branding edit waits until every report group has captured the same content version', async () => {
  const flow = await prepareReportFlow(owner, account, { productLines: 2 }); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const products = (await owner.query('SELECT id FROM sample_products WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [account.organizationId, flow.sample.id])).rows;
  const input = { ...flow.input, reportType: 'product_wise', templateSelections: products.map((product) => ({ key: product.id, templateId: flow.template.templateId })) };
  const firstReport = deferred(); const release = deferred(); const editStarted = deferred();
  let generationPid; let editPid; let inserted = false; let edited = false;
  const generation = work(async (client, identity) => {
    generationPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return generateReports({ query: async (statement, parameters) => {
      const result = await client.query(statement, parameters);
      if (!inserted && typeof statement === 'string' && statement.startsWith('INSERT INTO sample_reports(')) {
        inserted = true; firstReport.resolve(); await release.promise;
      }
      return result;
    } }, identity, flow.sample.id, input);
  });
  generation.catch(() => firstReport.resolve());
  await firstReport.promise;
  const edit = work(async (client, identity) => {
    editPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; editStarted.resolve();
    return saveReportDocument(client, identity, { ...assets.headerInput, requestId: randomUUID(), revision: 1, templateHtml: '<p>CONCURRENT HEADER</p>' });
  });
  edit.then(() => { edited = true; }, () => { edited = true; editStarted.resolve(); });
  let blocked = false;
  try {
    await editStarted.promise;
    const deadline = Date.now() + 5000;
    while (!blocked && !edited && Date.now() < deadline) {
      blocked = (await owner.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [generationPid, editPid])).rows[0].blocked;
      if (!blocked && !edited) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { release.resolve(); }
  const [generated] = await Promise.all([generation, edit]);
  const captured = (await owner.query('SELECT DISTINCT header_version_id FROM sample_report_assets WHERE organization_id=$1 AND report_id=ANY($2::uuid[])',
    [account.organizationId, generated.items.map((report) => report.id)])).rows;
  assert.deepEqual(captured, [{ header_version_id: assets.header.versionId }]);
  assert.equal(blocked, true);
});

test('a report reader can load only report-linked assets without report settings access, while foreign tenants cannot', async () => {
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [account.organizationId, account.userId, reader.roleId]);
  const flow = await prepareReportFlow(owner, account, { printRoleId: reader.roleId }); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const report = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const session = await signIn({ identifier: reader.username, password: reader.password });
  const run = (callback) => withSession(session.token, callback, { readOnly: true });
  assert.equal((await run((client, identity) => loadReport(client, identity, report.items[0].id))).assets.header.versionId, assets.header.versionId);
  await assert.rejects(run((client, identity) => loadReportDocument(client, identity, assets.header.id)), { code: 'forbidden' });
  const unrelated = await work(createReportAssets);
  const visible = await run((client) => client.query('SELECT id FROM report_image_assets WHERE id=ANY($1::uuid[])', [[assets.image.id, unrelated.image.id]]));
  assert.deepEqual(visible.rows, [{ id: assets.image.id }]);
  const foreign = await createAccount(owner, { permissions: ['samples.read', 'report_settings.read'] });
  const foreignSession = await signIn({ identifier: foreign.username, password: foreign.password });
  await assert.rejects(withSession(foreignSession.token, (client, identity) => loadReport(client, identity, report.items[0].id), { readOnly: true }), { code: 'report_not_found' });
});

test('SVG assets remain frozen in real PDFs and unsafe directly stored vectors cannot enter a report', async () => {
  const flow = await prepareReportFlow(owner, account); const assets = await work(createReportAssets);
  const vector = await work((client, identity) => uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Vector.svg', mediaType: 'image/svg+xml', content: reportSvg }));
  const version = await work((client, identity) => saveReportDocument(client, identity, { ...assets.headerInput, revision: 1, requestId: randomUUID(),
    templateHtml: `<p>FROZEN VECTOR HEADER</p><img src="${vector.url}" width="80" height="24">` }));
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)); const id = generated.items[0].id;
  await work((client, identity) => deleteReportDocument(client, identity, assets.header.id, { requestId: randomUUID(), revision: 2 }));
  const loaded = await work((client, identity) => loadReport(client, identity, id));
  assert.equal(loaded.assets.header.versionId, version.document.versionId); assert.equal(loaded.metrics.assets.queryCount, 1);
  assert.ok(loaded.assets.header.html.includes(`data:image/svg+xml;base64,${reportSvg.toString('base64')}`));
  const renderer = await loadReportRenderer(); const queued = await work((client, identity) => enqueueReportPdf(client, identity, id));
  assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
  const file = await work((client, identity) => reportPdfFile(client, identity, id));
  await writeFile('.local/m03-static-svg.pdf', file.content); assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');

  const unsafe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24"><script>alert(1)</script></svg>');
  const imageId = randomUUID();
  await work((client) => client.query(`INSERT INTO report_image_assets(organization_id,id,original_name,media_type,content,byte_length,sha256,width,height,uploaded_by)
    VALUES($1,$2,'Unsafe.svg','image/svg+xml',$3,$4,$5,80,24,$6)`, [account.organizationId, imageId, unsafe, unsafe.length, createHash('sha256').update(unsafe).digest('hex'), account.userId]));
  const unsafeHeader = await work((client, identity) => saveReportDocument(client, identity, { ...assets.headerInput, documentId: randomUUID(), requestId: randomUUID(), revision: 0,
    templateHtml: `<img src="/api/report-assets/images/${imageId}">` }));
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 2, { ...assets.command, headerDocumentId: unsafeHeader.document.id }));
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() })), { code: 'unsafe_report_svg' });
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM sample_reports WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rows[0].count, 1);
});

test('the restricted worker prints frozen rich headers, footers and image bytes after branding edits', async (context) => {
  const flow = await prepareReportFlow(owner, account); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)); const id = generated.items[0].id;
  await work((client, identity) => saveReportDocument(client, identity, { ...assets.headerInput, revision: 1, requestId: randomUUID(), templateHtml: '<p>CHANGED AFTER GENERATION</p>' }));
  const renderer = await loadReportRenderer();
  const queued = await work((client, identity) => enqueueReportPdf(client, identity, id));
  assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
  const file = await work((client, identity) => reportPdfFile(client, identity, id), { readOnly: true });
  assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
  const path = '.local/m03-captured-assets.pdf'; await writeFile(path, file.content);
  if (process.platform === 'darwin') {
    const pages = await pdfPageText(path, ['FROZEN LABORATORY HEADER', 'FROZEN LABORATORY FOOTER', 'CHANGED AFTER GENERATION']);
    assert.ok(pages.length > 0);
    for (const page of pages) {
      assert.equal(page.filter((row) => row.label === 'FROZEN LABORATORY HEADER').length, 1);
      assert.equal(page.filter((row) => row.label === 'FROZEN LABORATORY FOOTER').length, 1);
      assert.equal(page.filter((row) => row.label === 'CHANGED AFTER GENERATION').length, 0);
    }
  } else context.diagnostic('PDFKit text inspection is only available on macOS; Chrome generated and stored the real PDF.');
});
