import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { closePool, getPool } from '../src/db/pool.js';
import { createAnalyticalTemplate } from '../tests/helpers/templates.js';
import { freezeTemplate } from '../src/templates/authoring.js';
import { createCapture, saveCapture } from '../src/templates/capture.js';
import { loadCapture, loadDefinition } from '../src/templates/loader.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { quickCreateCustomer } from '../src/samples/customer.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { prepareReportFlow } from '../tests/helpers/report-flow.js';
import { prepareSubjectJob } from '../tests/helpers/job-subjects.js';
import { createReportTemplate } from '../tests/helpers/reports.js';
import { loadDatasheet } from '../src/datasheets/service.js';
import { loadWorkflowRun } from '../src/workflows/load.js';
import { submitDatasheetTransition } from '../src/workflows/requests.js';
import { generateReports } from '../src/reports/service.js';
import { enqueueReportPdf, reportPdfFile } from '../src/reports/jobs.js';
import { loadReportRenderer } from '../src/reports/renderer.js';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from '../src/reports/worker.js';

process.loadEnvFile('.env.worker.local');

const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
const appUrl = new URL(process.env.DATABASE_URL);
const workerUrl = new URL(process.env.WORKER_DATABASE_URL);
for (const [url, username] of [[ownerUrl, 'sampleify_owner'], [appUrl, 'sampleify_app'], [workerUrl, 'sampleify_report_worker']]) {
  if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local' || url.username !== username) {
    throw new Error('Migration verification requires the dedicated local synthetic database roles.');
  }
}

// A new database exercises every migration from an empty schema. Keep it for inspection;
// neither existing data nor previously applied migrations are reset or removed.
const databaseName = `sampleify_verify_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: ownerUrl.href });
let owner; let worker;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  ownerUrl.pathname = `/${databaseName}`;
  appUrl.pathname = `/${databaseName}`;
  workerUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = appUrl.href;
  owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const client = await owner.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' }); // Reapplying must be a no-op.
  } finally { client.release(); }
  const expected = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')).entries.length;
  const count = Number((await owner.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);
  assert.equal(count, expected);
  assert.equal((await owner.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')")).rowCount, 0);
  const role = (await getPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  assert.equal((await getPool().query('SELECT * FROM templates')).rowCount, 0);
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'settings.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  await withSession(session.token, async (client, identity) => {
    const template = await createAnalyticalTemplate(client, identity);
    await freezeTemplate(client, identity, template.versionId, 1);
    const capture = await createCapture(client, identity, template.versionId);
    const definition = await loadDefinition(client, identity.organization_id, template.versionId);
    const loaded = await loadCapture(client, identity.organization_id, capture.instanceId);
    assert.equal(definition.model.version.status, 'frozen');
    assert.equal(loaded.instance.version_id, template.versionId);
    assert.equal(loaded.occurrences.length, 3);
  }, { csrfToken: session.csrfToken });
  const laboratory = await createLaboratoryFixture(owner, account);
  await withSession(session.token, async (client, identity) => {
    const customer = await quickCreateCustomer(client, identity, { name: 'Synthetic fresh customer', legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
      contactPersonEmail: 'fresh@example.invalid', contactPersonPhone: '00000000', billToAddress: 'Synthetic billing\nSecond line', shipToAddress: 'Synthetic receiving' });
    const sample = await registerSample(client, identity, { ...laboratory.registration, sampleType: 'customer', customerId: customer.id, customerAddress: customer.addresses[0].text });
    const generated = await generateTestRequests(client, identity, sample.id);
    assert.equal(generated.items.length, 1);
    const allocated = await allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId });
    assert.ok(allocated.datasheetId); assert.equal(allocated.status, 'allocated');
    const loaded = await loadSample(client, identity, sample.id);
    assert.equal(loaded.customerName, customer.name); assert.equal(loaded.products[0].tests[0].requestStatus, 'allocated');
  }, { csrfToken: session.csrfToken });
  const reportFlow = await prepareReportFlow(owner, { ...account, ...session }, { finalSection: true });
  const generationInput = { ...reportFlow.input, finalizeSample: true };
  const generated = await withSession(session.token, (client, identity) => generateReports(client, identity, reportFlow.sample.id, generationInput), { csrfToken: session.csrfToken });
  assert.equal(generated.items[0].isFinalized, true);
  assert.equal(generated.sample.status, 'completed'); assert.equal(generated.sample.revision, 2);
  const retried = await withSession(session.token, (client, identity) => generateReports(client, identity, reportFlow.sample.id, generationInput), { csrfToken: session.csrfToken });
  assert.equal(retried.replayed, true); assert.equal(retried.sample.revision, 2);
  const reportId = generated.items[0].id;
  const queued = await withSession(session.token, (client, identity) => enqueueReportPdf(client, identity, reportId), { csrfToken: session.csrfToken });
  worker = createReportWorkerPool(workerUrl.href); await verifyReportWorkerRole(worker);
  assert.equal((await worker.query('SELECT id FROM sample_reports')).rowCount, 0);
  const printed = await processNextReportJob({ pool: worker, renderer: await loadReportRenderer(), workerId: randomUUID() });
  assert.deepEqual(printed, { jobId: queued.job.id, status: 'succeeded' });
  const pdf = await withSession(session.token, (client, identity) => reportPdfFile(client, identity, reportId), { readOnly: true });
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.byteLength > 5000);
  const signedAccount = { ...account, ...session };
  const jobFlow = await prepareSubjectJob(owner, signedAccount, signedAccount, { resultWidget: true });
  const work = (action, options = {}) => withSession(session.token, action, { csrfToken: session.csrfToken, ...options });
  let jobSheet = await work((client, identity) => loadDatasheet(client, identity, jobFlow.job.datasheetId), { readOnly: true });
  const fields = Object.values(jobSheet.model.fieldsById); const raw = fields.find((field) => field.alias === 'raw_0');
  const result = fields.find((field) => field.widget === 'result_widget');
  await work((client, identity) => saveCapture(client, identity, jobSheet.capture.instance.id, jobSheet.capture.revision,
    jobSheet.capture.occurrences.filter((row) => row.subject).flatMap((row, index) => [
      { fieldId: raw.id, occurrenceId: row.id, state: 'present', value: '0' },
      { fieldId: result.id, occurrenceId: row.id, state: 'present', value: index === 0 ? '0' : '4.20' },
    ])));
  jobSheet = await work((client, identity) => loadDatasheet(client, identity, jobFlow.job.datasheetId), { readOnly: true });
  const run = await work((client, identity) => loadWorkflowRun(client, identity, jobFlow.job.workflowRunId), { readOnly: true });
  await work((client, identity) => submitDatasheetTransition(client, identity, run.id, { datasheetId: jobSheet.datasheet.id,
    datasheet: { revision: jobSheet.datasheet.revision, captureRevision: jobSheet.capture.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Synthetic fresh job completion', checklistItemIds: [] } }));
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM laboratory_job_workflow_effects WHERE parent_request_id=$1 AND is_current', [jobFlow.job.id])).rows[0].count, 2);
  const template = await work(createReportTemplate);
  const selected = (await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND parent_test_request_id=$2', [account.organizationId, jobFlow.job.id])).rows;
  const jobReports = await work((client, identity) => generateReports(client, identity, jobFlow.sample.id, { revision: jobFlow.sample.revision, requestId: randomUUID(),
    reportType: 'consolidated', selectedSampleTestIds: selected.map((row) => row.sample_test_id), templateSelections: [{ key: 'consolidated', templateId: template.templateId }] }));
  const jobReportId = jobReports.items[0].id;
  const jobPrint = await work((client, identity) => enqueueReportPdf(client, identity, jobReportId));
  assert.deepEqual(await processNextReportJob({ pool: worker, renderer: await loadReportRenderer(), workerId: randomUUID() }), { jobId: jobPrint.job.id, status: 'succeeded' });
  const jobPdf = await work((client, identity) => reportPdfFile(client, identity, jobReportId), { readOnly: true });
  assert.equal(jobPdf.content.subarray(0, 5).toString(), '%PDF-'); assert.ok(jobPdf.byteLength > 5000);
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile('.local/migration-verification.json', JSON.stringify({ databaseName, migrations: count, status: 'passed', verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Fresh install and repeat application passed for ${count} migrations; authentication, template capture, registration, allocation, grouped results/workflow, report finalisation/retry and two frozen PDF jobs passed with restricted application/worker roles. Synthetic database retained: ${databaseName}`);
} finally {
  await worker?.end();
  await closePool();
  await owner?.end();
  await admin.end();
}
