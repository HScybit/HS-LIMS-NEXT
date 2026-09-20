import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareParameterTitleFlow } from '../helpers/parameter-titles.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool, transaction } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { loadDatasheetContext } from '../../src/datasheets/context.js';
import { saveTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { enqueueReportPdf, reportPdfFile } from '../../src/reports/jobs.js';
import { processNextReportJob, createReportWorkerPool } from '../../src/reports/worker.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const permissions = ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'];
const work = (account, action) => withSession(account.token, action, { csrfToken: account.csrfToken });
async function account(options = {}) {
  const user = await createAccount(owner, { permissions, ...options });
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}

test('parameter-only Text and Vertical titles use the actual row history in datasheets and frozen report output', async () => {
  const author = await account(); const flow = await prepareParameterTitleFlow(owner, author);
  const reader = await account({ organizationId: author.organizationId, permissions: ['samples.read'] });
  const sheet = await work(reader, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  assert.equal(sheet.metrics.metadataQueryCount, 2);
  let metadataQueries = 0;
  await work(reader, (client, identity) => loadDatasheetContext({ query: (...args) => { metadataQueries += 1; return client.query(...args); } }, identity, sheet.datasheet, sheet.capture.revision));
  assert.equal(metadataQueries, 1, 'One metadata statement serves every repeated title');
  const parameter = sheet.dataContext.parametersByRequestId[flow.requestId].parameterTitleValues;
  assert.deepEqual(parameter, { _id: flow.fixture.parameter.id, organization_id: author.organizationId, name: 'Captured parameter', key: 'CAPTURED-KEY',
    description: '<b>Captured H<sub>2</sub>O</b>', order: 0, scheme_abbr: 'CP', lab_id: flow.fixture.laboratory.id });
  assert.equal((await work(reader, (client) => client.query('SELECT * FROM test_parameter_versions'))).rowCount, 0);
  const generated = await work(author, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const original = await work(author, (client, identity) => loadReport(client, identity, reportId));
  assert.deepEqual(original.results[0].parameterTitleValues, parameter);
  const renderer = await loadReportRenderer(); const html = renderer.renderReportDocument(original, renderer.stylesheet);
  assert.match(html, /<b>Captured H<sub>2<\/sub>O<\/b>/);
  assert.match(html, /writing-mode:vertical-rl[^>]*>Captured parameter<\/p>/);
  assert.match(html, /writing-mode:vertical-rl[^>]*>0<\/p>/);
  assert.match(html, /<div>name<\/div>/, 'A row outside the loop keeps its literal title');
  const saved = await work(author, (client, identity) => saveTestParameter(client, identity, { ...flow.parameterCommand, revision: 2, requestId: randomUUID(),
    name: 'Later parameter', key: 'LATER-KEY', description: 'Later description', schemeAbbreviation: 'LP', order: 9 }));
  await work(author, (client, identity) => retireTestParameter(client, identity, { id: saved.id, revision: saved.revision, requestId: randomUUID() }));
  const later = await work(author, (client, identity) => loadReport(client, identity, reportId));
  assert.equal(renderer.renderReportDocument(later, renderer.stylesheet), html);
  assert.deepEqual((await work(reader, (client, identity) => loadDatasheet(client, identity, flow.sheet.id))).dataContext, sheet.dataContext);
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool();
  try {
    const queued = await work(author, (client, identity) => enqueueReportPdf(client, identity, reportId));
    assert.deepEqual(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), { jobId: queued.job.id, status: 'succeeded' });
    const file = await work(author, (client, identity) => reportPdfFile(client, identity, reportId));
    assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
    await writeFile('.local/m03-parameter-titles-report.pdf', file.content);
  } finally { await worker.end(); }
});

test('pre-history parameters retain only their actual specification fields after later history is created', async () => {
  const author = await account(); const flow = await prepareParameterTitleFlow(owner, author, { complete: false, history: false });
  const original = await work(author, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  const parameter = original.dataContext.parametersByRequestId[flow.requestId].parameterTitleValues;
  assert.deepEqual(parameter, { _id: flow.fixture.parameter.id, organization_id: author.organizationId, name: flow.fixture.parameter.name, key: flow.fixture.parameter.masterKey });
  await work(author, (client, identity) => saveTestParameter(client, identity, { id: flow.fixture.parameter.id, revision: 1, requestId: randomUUID(),
    name: 'Newer name', key: 'NEWER-KEY', schemeAbbreviation: 'NEWER', description: 'Not historical', order: 0, laboratoryId: null, measurementUncertainty: null }));
  const later = await work(author, (client, identity) => loadDatasheet(client, identity, flow.sheet.id));
  assert.deepEqual(later.dataContext, original.dataContext);
});

test('parameter projections require active laboratory access or the exact report live worker lease', async () => {
  const author = await account(); const flow = await prepareParameterTitleFlow(owner, author, { productLines: 2,
    prepareParameter: async (client, identity) => {
      const field = await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
        key: 'scoped', label: 'Scoped field', fieldType: 'text', associatedWith: 'parameter' });
      return { customFields: [{ fieldId: field.id, fieldRevision: field.revision, value: 'Selected history' }] };
    } });
  const denied = await account({ organizationId: author.organizationId, permissions: ['samples.create'] });
  const foreign = await account({ permissions: ['samples.read'] });
  assert.equal((await owner.query('SELECT * FROM laboratory_parameter_context')).rowCount, 0);
  assert.equal((await getPool().query('SELECT * FROM laboratory_parameter_context')).rowCount, 0);
  const views = ['laboratory_parameter_context', 'laboratory_parameter_field_context', 'laboratory_parameter_value_context'];
  for (const user of [denied, foreign]) for (const view of views) assert.equal((await work(user, (client) => client.query(`SELECT * FROM ${view}`))).rowCount, 0);
  const unbound = await work(author, (client, identity) => saveTestParameter(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(),
    name: 'Unbound metadata', key: 'UNBOUND', schemeAbbreviation: 'UNBOUND', description: 'Not captured', order: 0, laboratoryId: null, measurementUncertainty: null,
    customFields: flow.parameterCommand.customFields }));
  assert.equal((await work(author, (client) => client.query('SELECT * FROM laboratory_parameter_context WHERE parameter_id=$1', [unbound.id]))).rowCount, 0);
  assert.equal((await work(author, (client) => client.query('SELECT * FROM laboratory_parameter_field_context WHERE parameter_id=$1', [unbound.id]))).rowCount, 0);
  await prepareParameterTitleFlow(owner, author, { complete: false, prepareParameter: async () => ({ key: 'UNSELECTED', schemeAbbreviation: 'UNSELECTED', customFields: flow.parameterCommand.customFields }) });
  assert.equal((await work(author, (client) => client.query("SELECT has_table_privilege(current_user,'laboratory_parameter_context','INSERT,UPDATE,DELETE') AS allowed"))).rows[0].allowed, false);
  await assert.rejects(work(author, (client) => client.query('DELETE FROM laboratory_parameter_context WHERE false')), { code: '55000' });
  const generated = await work(author, (client, identity) => generateReports(client, identity, flow.sample.id,
    { ...flow.input, selectedSampleTestIds: [flow.completed[0].sampleTestId] }));
  const reportId = generated.items[0].id;
  const selected = (await owner.query('SELECT specification_id FROM sample_report_tests WHERE organization_id=$1 AND report_id=$2', [author.organizationId, reportId])).rows;
  assert.equal(selected.length, 1);
  const rendererId = createHash('sha256').update(randomUUID()).digest('hex');
  await work(author, (client) => client.query('SELECT report_pdf_enqueue($1,$2)', [reportId, rendererId]));
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool(); let job;
  try {
    job = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
    const lease = [job.organization_id, job.job_id, job.lease_token];
    const leaseHash = await transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [author.organizationId, author.userId]);
      assert.equal((await client.query('SELECT * FROM laboratory_parameter_context')).rowCount, 0);
      const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease)).rows[0];
      assert.deepEqual((await client.query('SELECT specification_id FROM laboratory_parameter_context')).rows, selected);
      assert.deepEqual((await client.query('SELECT parameter_id,display_text FROM laboratory_parameter_field_context')).rows,
        [{ parameter_id: flow.fixture.parameter.id, display_text: 'Selected history' }]);
      assert.deepEqual((await client.query('SELECT parameter_id,raw_text FROM laboratory_parameter_value_context')).rows,
        [{ parameter_id: flow.fixture.parameter.id, raw_text: 'Selected history' }]);
      assert.equal((await loadReport(client, identity, reportId)).results[0].parameterTitleValues.order, 0);
      const hash = (await client.query("SELECT current_setting('app.report_pdf_lease_hash') AS hash")).rows[0].hash;
      await client.query("SELECT set_config('app.report_pdf_lease_hash','invalid',true)");
      for (const view of views) assert.equal((await client.query(`SELECT * FROM ${view}`)).rowCount, 0);
      await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease);
      await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [author.organizationId, author.userId]);
      try { for (const view of views) assert.equal((await client.query(`SELECT * FROM ${view}`)).rowCount, 0); }
      finally { await owner.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND user_id=$2', [author.organizationId, author.userId]); }
      return hash;
    }, { pool: worker });
    await assert.rejects(worker.query('SELECT * FROM test_parameter_versions'), { code: '42501' });
    await assert.rejects(worker.query('SELECT * FROM parameter_version_custom_fields'), { code: '42501' });
    await assert.rejects(worker.query('SELECT * FROM parameter_version_custom_field_values'), { code: '42501' });
    await owner.query('UPDATE report_pdf_jobs SET lease_expires_at=started_at+(clock_timestamp()-started_at)/2 WHERE organization_id=$1 AND id=$2', [job.organization_id, job.job_id]);
    await transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('app.report_pdf_job_id',$3,true),set_config('app.report_pdf_lease_hash',$4,true)",
        [author.organizationId, author.userId, job.job_id, leaseHash]);
      for (const view of views) assert.equal((await client.query(`SELECT * FROM ${view}`)).rowCount, 0);
    }, { pool: worker });
  } finally {
    if (job) {
      const reclaimed = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
      const current = reclaimed ?? job;
      await transaction((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [current.organization_id, current.job_id, current.lease_token, 'synthetic_stop', 'Synthetic parameter lease check complete.']), { pool: worker });
    }
    await worker.end();
  }
});
