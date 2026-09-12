import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { createReportAssets } from '../helpers/report-assets.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadCustomCss, saveCustomCss } from '../../src/report-assets/custom-css.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';
import { pdfPageText } from '../helpers/pdf-page-text.js';

const owner = ownerPool(); let account; let worker;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const save = (cssContent) => work(async (client, identity) => saveCustomCss(client, identity, { requestId: randomUUID(), revision: (await loadCustomCss(client, identity)).revision, cssContent }));
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'report_settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  process.loadEnvFile('.env.worker.local'); worker = createReportWorkerPool();
});
after(async () => { await worker.end(); await closePool(); await owner.end(); });

test('report styles and shared image bytes stay frozen after edits and clearing, with one batched asset read', async () => {
  const flow = await prepareReportFlow(owner, account, { finalSection: true }); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const empty = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const stylesheet = await save(`.coa-pdf-document{--logo:url('${assets.image.url}');background-image:var(--logo);color:#005577}`);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  let reads = 0;
  const original = await work((client, identity) => loadReport({ query: (statement, parameters) => {
    if (typeof statement === 'string' && statement.startsWith('WITH selected AS (')) reads += 1;
    return client.query(statement, parameters);
  } }, identity, generated.items[0].id), { readOnly: true });
  assert.equal(reads, 1); assert.equal(original.metrics.definition.queryCount, 8); assert.equal(original.metrics.capture.queryCount, 3);
  assert.equal(original.metrics.assets.queryCount, 1); assert.equal(original.metrics.assets.rows, 4);
  assert.equal(original.metrics.assets.stylesheets, 1); assert.equal(original.metrics.assets.images, 1);
  assert.equal(original.assets.customCss.versionId, stylesheet.versionId);
  assert.ok(original.assets.customCss.css.includes(`data:image/png;base64,${assets.content.toString('base64')}`));
  await save('.coa-pdf-document{color:red}'); const cleared = await save('');
  const current = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, current.items[0].id))).assets.customCss, { versionId: cleared.versionId, css: '' });
  assert.deepEqual((await work((client, identity) => loadReport(client, identity, generated.items[0].id))).assets, original.assets);
  assert.equal((await work((client, identity) => loadReport(client, identity, empty.items[0].id))).assets.customCss, undefined);
  await assert.rejects(owner.query('UPDATE sample_report_assets SET css_version_id=$3 WHERE organization_id=$1 AND report_id=$2', [account.organizationId, generated.items[0].id, cleared.versionId]), { code: '55000' });
});

test('report readers receive captured CSS and images but cannot read unrelated history or foreign reports', async () => {
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
  await owner.query('INSERT INTO membership_roles(organization_id,user_id,role_id) VALUES($1,$2,$3)', [account.organizationId, account.userId, reader.roleId]);
  const flow = await prepareReportFlow(owner, account, { printRoleId: reader.roleId }); const assets = await work(createReportAssets);
  const stylesheet = await save(`.coa-pdf-document{background:url('${assets.image.url}')}`);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const unrelated = await save('.unrelated{color:red}');
  const session = await signIn({ identifier: reader.username, password: reader.password });
  const run = (callback) => withSession(session.token, callback, { readOnly: true });
  const captured = await run((client, identity) => loadReport(client, identity, generated.items[0].id));
  assert.equal(captured.assets.customCss.versionId, stylesheet.versionId); assert.match(captured.assets.customCss.css, /data:image\/png;base64,/);
  assert.deepEqual((await run((client) => client.query('SELECT id FROM organization_custom_css_versions WHERE id=ANY($1::uuid[])', [[stylesheet.versionId, unrelated.versionId]]))).rows, [{ id: stylesheet.versionId }]);
  await assert.rejects(run(loadCustomCss), { code: 'forbidden' });
  const foreign = await createAccount(owner, { permissions: ['samples.read', 'report_settings.read'] });
  const foreignSession = await signIn({ identifier: foreign.username, password: foreign.password });
  await assert.rejects(withSession(foreignSession.token, (client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true }), { code: 'report_not_found' });
});

test('concurrent CSS edits wait until every report group captures the same stylesheet', async () => {
  const flow = await prepareReportFlow(owner, account, { productLines: 2 }); const stylesheet = await save('.frozen{color:blue}');
  const products = (await owner.query('SELECT id FROM sample_products WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [account.organizationId, flow.sample.id])).rows;
  const input = { ...flow.input, reportType: 'product_wise', templateSelections: products.map((product) => ({ key: product.id, templateId: flow.template.templateId })) };
  const firstReport = deferred(); const release = deferred(); const editStarted = deferred();
  let generationPid; let editPid; let inserted = false; let edited = false;
  const generation = work(async (client, identity) => {
    generationPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return generateReports({ query: async (statement, parameters) => {
      const result = await client.query(statement, parameters);
      if (!inserted && typeof statement === 'string' && statement.startsWith('INSERT INTO sample_reports(')) { inserted = true; firstReport.resolve(); await release.promise; }
      return result;
    } }, identity, flow.sample.id, input);
  });
  generation.catch(() => firstReport.resolve()); await firstReport.promise;
  const edit = work(async (client, identity) => {
    editPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; editStarted.resolve();
    return saveCustomCss(client, identity, { requestId: randomUUID(), revision: stylesheet.revision, cssContent: '.concurrent{color:red}' });
  });
  edit.then(() => { edited = true; }, () => { edited = true; editStarted.resolve(); });
  let blocked = false;
  try {
    await editStarted.promise; const deadline = Date.now() + 5000;
    while (!blocked && !edited && Date.now() < deadline) {
      blocked = (await owner.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [generationPid, editPid])).rows[0].blocked;
      if (!blocked && !edited) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { release.resolve(); }
  const [generated] = await Promise.all([generation, edit]);
  assert.equal(blocked, true);
  assert.deepEqual((await owner.query('SELECT DISTINCT css_version_id FROM sample_report_assets WHERE organization_id=$1 AND report_id=ANY($2::uuid[])',
    [account.organizationId, generated.items.map((report) => report.id)])).rows, [{ css_version_id: stylesheet.versionId }]);
});

test('uncaptured resources and inconsistent CSS links roll back publication and finalisation', async () => {
  const flow = await prepareReportFlow(owner, account); const assets = await work(createReportAssets);
  for (const css of ['.report{background:url(https://example.invalid/image)}', '@import "https://example.invalid/style.css";', '.report{bad;color:red}', '@font-face{font-family:Remote;src:local("Uncaptured font")}']) {
    await save(css); const input = { ...flow.input, requestId: randomUUID(), finalizeSample: true };
    await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, input)), { code: 'report_css_not_captured' });
    assert.equal((await owner.query('SELECT id FROM sample_events WHERE organization_id=$1 AND id=$2', [account.organizationId, input.requestId])).rowCount, 0);
  }
  await work(async (client, identity) => {
    const previous = await loadCustomCss(client, identity);
    await client.query('SELECT * FROM report_save_custom_css($1,$2,$3,$4)', [randomUUID(), previous.revision, `.report{background:url('${assets.image.url}')}`, []]);
  });
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)), { code: 'report_asset_history_unavailable' });
  // Preserve the PNG signature and dimensions while removing compressed pixels.
  const corrupt = assets.content.subarray(0, 33); const imageId = randomUUID();
  await work((client) => client.query(`INSERT INTO report_image_assets(organization_id,id,original_name,media_type,content,byte_length,sha256,width,height,uploaded_by)
    VALUES($1,$2,'Corrupted background.png','image/png',$3,$4,$5,80,24,$6)`, [account.organizationId, imageId, corrupt, corrupt.length, createHash('sha256').update(corrupt).digest('hex'), account.userId]));
  await save(`.report{background:url('/api/report-assets/images/${imageId}')}`);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)), { code: 'invalid_report_image' });
  assert.equal((await owner.query('SELECT id FROM sample_reports WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rowCount, 0);
  assert.deepEqual((await owner.query('SELECT status,revision FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, flow.sample.id])).rows[0], { status: 'registered', revision: 1 });
});

test('the leased worker prints frozen CSS in the report body and repeated header/footer areas after clearing', async (context) => {
  const flow = await prepareReportFlow(owner, account); const assets = await work(createReportAssets);
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, assets.command));
  const stylesheet = await save(`.coa-pdf-document [data-is-header="true"] p::after{content:" FROZEN CSS HEADER";font-size:14px}
    .coa-pdf-document [data-is-footer="true"] p::after{content:" FROZEN CSS FOOTER";font-size:14px}
    .template-render-canvas::after{display:block;height:2000px;content:"FROZEN CSS BODY";background-image:url('${assets.image.url}');background-repeat:no-repeat;background-position:bottom left}`);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)); const reportId = generated.items[0].id;
  await save(''); const renderer = await loadReportRenderer();
  const queued = await work((client, identity) => enqueueReportPdf(client, identity, reportId));
  assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
  const file = await work((client, identity) => reportPdfFile(client, identity, reportId)); const path = '.local/m03-frozen-custom-css.pdf'; await writeFile(path, file.content);
  assert.equal((await work((client, identity) => loadReport(client, identity, reportId))).assets.customCss.versionId, stylesheet.versionId);
  if (process.platform === 'darwin') {
    const pages = await pdfPageText(path, ['FROZEN CSS HEADER', 'FROZEN CSS FOOTER', 'FROZEN CSS BODY']);
    assert.ok(pages.length >= 2);
    for (const page of pages) {
      assert.equal(page.filter((row) => row.label === 'FROZEN CSS HEADER').length, 1);
      assert.equal(page.filter((row) => row.label === 'FROZEN CSS FOOTER').length, 1);
    }
    assert.equal(pages.flat().filter((row) => row.label === 'FROZEN CSS BODY').length, 1);
  } else context.diagnostic('PDFKit content inspection requires macOS; the leased worker generated and retained the real PDF.');
});
