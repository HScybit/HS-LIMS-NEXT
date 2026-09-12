import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { createReportTemplate } from '../helpers/reports.js';
import { randomUUID } from 'node:crypto';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { renderReportPdf } from '../../src/reports/pdf.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture } from '../../src/templates/capture.js';
import { addTestRequestMethod } from '../../src/test-requests/methods.js';
import { loadTestRequest } from '../../src/test-requests/load.js';
import { loadWorkflowRun } from '../../src/workflows/load.js';
import { submitDatasheetTransition } from '../../src/workflows/requests.js';

const owner = ownerPool(); let account; let renderer; let stylesheet;
before(async () => {
  await import('../../scripts/build-report-renderer.js');
  const { rendererId } = JSON.parse(await readFile('.local/report-renderers/current.json', 'utf8'));
  assert.match(rendererId, /^[a-f0-9]{64}$/);
  const directory = path.resolve('.local/report-renderers', rendererId);
  renderer = await import(pathToFileURL(path.join(directory, 'renderer.mjs')));
  stylesheet = await readFile(path.join(directory, 'stylesheet.css'), 'utf8');
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('the shared frozen renderer produces a real PDF with repeated zero results and rejects uncaptured remote resources', async () => {
  const flow = await prepareReportFlow(owner, account, { finalSection: true, finalContext: true });
  const work = (action, options) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const data = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  const html = renderer.renderReportDocument(data, stylesheet);
  assert.match(html, /CERTIFICATE OF ANALYSIS/);
  assert.equal((html.match(/>0\.00</g) ?? []).length, 6);
  assert.equal((html.match(/>Synthetic concentration</g) ?? []).length, 2, 'Report and nested final-section context must use the frozen parameter label.');
  assert.equal(html.includes('<script'), false);
  const bytes = await renderReportPdf({ html, printConfig: data.printConfig, stylesheet });
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-'); assert.ok(bytes.length > 5000);
  await writeFile('.local/m03-pdf-renderer-preview.pdf', bytes);
  await owner.query("UPDATE test_parameters SET name='Changed later parameter',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.fixture.parameter.id]);
  const later = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(renderer.renderReportDocument(later, stylesheet), html);
  await assert.rejects(renderReportPdf({ html: '<html><body><img src="http://127.0.0.1:9/uncaptured.png"></body></html>', printConfig: data.printConfig, stylesheet: '' }), { code: 'report_external_resource' });
});

test('a completed job renders each actual summary result and frozen specification even when a child uses an alternate method', async () => {
  const work = (action, options) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
  const flow = await prepareSubjectJob(owner, account, account, { resultWidget: true });
  let sheet = await work((client, identity) => loadDatasheet(client, identity, flow.job.datasheetId), { readOnly: true });
  const rows = sheet.capture.occurrences.filter((row) => row.subject);
  const primary = rows.find((row) => row.subject.parameterName === flow.source.parameter.name);
  assert.ok(primary);
  const child = await work((client, identity) => loadTestRequest(client, identity, primary.subject.testRequestId), { readOnly: true });
  const method = await createAlternateMethod(owner, account, flow.source);
  const added = await work((client, identity) => addTestRequestMethod(client, identity, child.id, { revision: child.revision, methodId: method.id }));
  const fields = Object.values(sheet.model.fieldsById); const raw = fields.find((field) => field.alias === 'raw_0');
  const result = fields.find((field) => field.widget === 'result_widget');
  const expected = new Map(rows.map((row, index) => [row.subject.testRequestId, index === 0 ? '0' : '4.20']));
  await work((client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    rows.flatMap((row) => [{ fieldId: raw.id, occurrenceId: row.id, state: 'present', value: '0' },
      { fieldId: result.id, occurrenceId: row.id, state: 'present', value: expected.get(row.subject.testRequestId) }])));
  sheet = await work((client, identity) => loadDatasheet(client, identity, flow.job.datasheetId), { readOnly: true });
  const run = await work((client, identity) => loadWorkflowRun(client, identity, flow.job.workflowRunId), { readOnly: true });
  await work((client, identity) => submitDatasheetTransition(client, identity, run.id, { datasheetId: sheet.datasheet.id,
    datasheet: { revision: sheet.datasheet.revision, captureRevision: sheet.capture.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Synthetic complete summary', checklistItemIds: [] } }));
  const selected = await work((client, identity) => loadTestRequest(client, identity, child.id), { readOnly: true });
  assert.equal(selected.finalDatasheetId, added.datasheetId);
  assert.equal(selected.datasheets.find((item) => item.id === added.datasheetId).status, 'approved');
  assert.equal(selected.datasheets.find((item) => item.id !== added.datasheetId).status, 'in_progress');
  const template = await work(createReportTemplate);
  const tests = await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND parent_test_request_id=$2', [account.organizationId, flow.job.id]);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, { revision: flow.sample.revision, requestId: randomUUID(),
    reportType: 'consolidated', selectedSampleTestIds: tests.rows.map((row) => row.sample_test_id), templateSelections: [{ key: 'consolidated', templateId: template.templateId }] }));
  const data = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(data.results.length, 2); assert.equal(data.metrics.definition.queryCount, 8); assert.equal(data.metrics.capture.queryCount, 0);
  for (const item of data.results) {
    assert.equal(item.numberValue, expected.get(item.testRequestId)); assert.equal(item.source, 'result_widget');
    assert.equal(item.instanceId, sheet.capture.instance.id);
    assert.equal(item.methodName, rows.find((row) => row.subject.testRequestId === item.testRequestId).subject.methodName);
  }
  const html = renderer.renderReportDocument(data, stylesheet);
  assert.match(html, />0</); assert.match(html, />4\.20</); assert.equal(html.includes(method.name), false);
  const bytes = await renderReportPdf({ html, printConfig: data.printConfig, stylesheet });
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-'); assert.ok(bytes.length > 5000);
  await writeFile('.local/m03-group-report-preview.pdf', bytes);
  await owner.query("UPDATE methods_of_analysis SET name='Later master method',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.source.method.id]);
  const later = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.equal(renderer.renderReportDocument(later, stylesheet), html);
});
