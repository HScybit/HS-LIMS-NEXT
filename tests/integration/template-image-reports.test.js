import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { addImageWidget } from '../helpers/template-image-fixture.js';
import { animatedPng, animatedRaster } from '../helpers/template-images.js';
import { pdfPageImage } from '../helpers/pdf-page-image.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { uploadTemplateImage } from '../../src/template-assets/service.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportAssetBatch } from '../../src/reports/assets.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';

const owner = ownerPool(); let account; let worker;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.read', 'samples.manage', 'templates.read', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  process.loadEnvFile('.env.worker.local'); worker = createReportWorkerPool();
});
after(async () => { await worker.end(); await closePool(); await owner.end(); });

test('generated reports batch historical template/result images and restricted-worker PDFs print their fixed first frames', async (context) => {
  const original = { requestId: randomUUID(), originalName: 'APNG separate fallback.png', mediaType: 'image/png', content: await animatedPng({ separateDefault: true, width: 24, height: 12, orientation: 6 }) };
  let finalField;
  const flow = await prepareReportFlow(owner, account, { finalSection: true, prepareDatasheet: async (client, identity, template) => {
    finalField = await addImageWidget(client, identity, template, original, { rowId: template.records.rows[0].id });
  } });
  const reportImage = { requestId: randomUUID(), originalName: 'Report animation.gif', mediaType: 'image/gif', content: await animatedRaster('gif') };
  const authored = await work((client, identity) => addImageWidget(client, identity, flow.template, reportImage, { sectionId: flow.template.records.sections[0].id }));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const report = await work((client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.equal(report.metrics.definition.queryCount, 9); assert.equal(report.metrics.capture.queryCount, 3); assert.equal(report.metrics.assets.queryCount, 1);
  assert.equal(report.metrics.assets.images, 2); assert.equal(report.metrics.imageCounts[original.requestId], 2);
  assert.equal(report.metrics.imageCounts[reportImage.requestId], 1);
  assert.equal(report.assets.templateImages[original.requestId].src, `data:image/png;base64,${original.content.toString('base64')}`);
  assert.ok(report.finalCaptures[flow.sheet.template_instance_id].values.some((value) => value.fieldId === finalField.fieldId && value.imageId === original.requestId));
  const blue = { requestId: randomUUID(), originalName: 'Replacement.png', mediaType: 'image/png', content: await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer() };
  await work((client, identity) => uploadTemplateImage(client, identity, flow.template.versionId, authored.fieldId, authored.model.version.revision, blue));
  const historical = await work((client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.deepEqual(historical.assets, report.assets);
  await assert.rejects(work((client, identity) => loadReportAssetBatch(client, identity.organization_id, [reportId], { [reportId]: { [original.requestId]: 100000 } })), { code: 'report_asset_size_limit' });
  const queued = await work((client, identity) => enqueueReportPdf(client, identity, reportId));
  const renderer = await loadReportRenderer();
  const printed = await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() });
  assert.deepEqual(printed, { jobId: queued.job.id, status: 'succeeded' });
  const file = await work((client, identity) => reportPdfFile(client, identity, reportId), { readOnly: true });
  assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
  const destination = '.local/m03-template-images-report.pdf'; await writeFile(destination, file.content);
  if (process.platform === 'darwin') {
    const pixels = await sharp(await pdfPageImage(destination)).removeAlpha().raw().toBuffer();
    let red = 0; let green = 0; let blueCount = 0;
    for (let index = 0; index < pixels.length; index += 3) {
      if (pixels[index] > 240 && pixels[index + 1] < 20 && pixels[index + 2] < 20) red++;
      if (pixels[index] < 20 && pixels[index + 1] > 100 && pixels[index + 2] < 20) green++;
      if (pixels[index] < 20 && pixels[index + 1] < 20 && pixels[index + 2] > 240) blueCount++;
    }
    assert.ok(red > 100, `Expected first-frame red pixels; received ${red}.`);
    assert.equal(green, 0); assert.equal(blueCount, 0);
  } else context.diagnostic('PDFKit pixel inspection requires macOS; the leased worker generated and retained the real PDF.');
});
