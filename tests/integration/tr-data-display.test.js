import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareTrDataDisplayFlow, renameTrParameter, trScientificMarkup } from '../helpers/tr-data.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { createReportWorkerPool, processNextReportJob } from '../../src/reports/worker.js';
import { contextWidgetValue } from '../../src/templates/context-widgets.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('TR scientific markup renders from frozen domain labels in final sections and restricted-worker reports', async () => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const work = (action, readOnly = false) => withSession(account.token, action, { csrfToken: account.csrfToken, readOnly });
  const flow = await prepareTrDataDisplayFlow(owner, account);
  const datasheet = await work((client, identity) => loadDatasheet(client, identity, flow.sheet.id), true);
  const field = Object.values(datasheet.model.fieldsById).find((field) => field.widget === 'tr_data_widget');
  assert.equal(contextWidgetValue(field, datasheet.dataContext), trScientificMarkup);
  assert(!datasheet.capture.values.some((value) => value.fieldId === field.id));
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const original = await work((client, identity) => loadReport(client, identity, reportId), true);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert((html.match(/<strong>Water H<sub>2<\/sub>O<\/strong>/g) ?? []).length >= 2);
  assert(html.includes('&amp; x<sup>2</sup> = 0'));
  await work((client, identity) => renameTrParameter(client, identity, flow.fixture.parameter.id, 'Later parameter name'));
  const reloaded = await work((client, identity) => loadReport(client, identity, reportId), true);
  assert.equal(renderer.renderReportDocument(reloaded, renderer.stylesheet), html);
  assert.equal(reloaded.results[0].parameterName, trScientificMarkup);
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work((client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    const file = await work((client, identity) => reportPdfFile(client, identity, reportId), true);
    assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
  } finally { await worker.end(); }
});
