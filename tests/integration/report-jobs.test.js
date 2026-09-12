import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool, transaction } from '../../src/db/pool.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { enqueueReportPdf, reportPdfStatus, reportPdfFile } from '../../src/reports/jobs.js';
import { loadReportRenderer } from '../../src/reports/renderer.js';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from '../../src/reports/worker.js';

process.loadEnvFile('.env.worker.local');
const workerUrl = new URL(process.env.WORKER_DATABASE_URL);
if (workerUrl.hostname !== '127.0.0.1' || workerUrl.port !== '55442' || workerUrl.pathname !== '/sampleify_local') throw new Error('Worker tests require the isolated synthetic database.');
const owner = ownerPool(); const worker = createReportWorkerPool(); let account;
const permissions = ['samples.create', 'samples.read', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'];
const work = (action, options = {}, user = account) => withSession(user.token, action, { csrfToken: user.csrfToken, ...options });
const workerWork = (action) => transaction(action, { pool: worker });
const fakePdf = Buffer.from('%PDF-1.4\n' + 'Synthetic integrity-test bytes.\n'.repeat(8));
const lease = (job) => [job.organization_id, job.job_id, job.lease_token];
const rendererId = () => createHash('sha256').update(randomUUID()).digest('hex');
const claim = (id) => workerWork(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [id, randomUUID()])).rows[0]);

before(async () => {
  const user = await createAccount(owner, { permissions });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  await verifyReportWorkerRole(worker);
  const functions = await worker.query("SELECT proc.proname FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace WHERE ns.nspname='public' AND proc.prosecdef AND has_function_privilege(current_user,proc.oid,'EXECUTE') ORDER BY proc.proname");
  assert.deepEqual(functions.rows.map((row) => row.proname), ['report_pdf_begin_read', 'report_pdf_claim', 'report_pdf_complete', 'report_pdf_context_org', 'report_pdf_fail']);
});
after(async () => { await closePool(); await worker.end(); await owner.end(); });

async function reportFixture(user = account, options = {}) {
  const flow = await prepareReportFlow(owner, user, options);
  const result = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input), {}, user);
  return { ...flow, reportId: result.items[0].id };
}
async function enqueue(reportId, id, user = account) {
  return work(async (client) => (await client.query('SELECT report_pdf_enqueue($1,$2) AS id', [reportId, id])).rows[0].id, {}, user);
}

test('duplicate requests share one durable job and concurrent workers cannot claim the same attempt', async () => {
  const flow = await reportFixture(); const id = rendererId();
  const ids = await Promise.all([enqueue(flow.reportId, id), enqueue(flow.reportId, id)]);
  assert.equal(ids[0], ids[1]);
  const claims = (await Promise.all([claim(id), claim(id)])).filter(Boolean);
  assert.equal(claims.length, 1); assert.equal(claims[0].attempt_number, 1);
  assert.equal(await claim(rendererId()), undefined);
  const state = await work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true });
  assert.equal(state.job.status, 'running'); assert.equal(state.history.length, 1);
  assert.equal('leaseToken' in state.job, false); assert.equal('lease_token_hash' in state.job, false);
  await assert.rejects(getPool().query('SELECT * FROM report_pdf_jobs'), { code: '42501' });
  await assert.rejects(getPool().query('SELECT * FROM report_pdf_claim($1,$2)', [id, randomUUID()]), { code: '42501' });
  await assert.rejects(work((client) => client.query('UPDATE report_pdf_jobs SET status=$1 WHERE id=$2', ['failed', ids[0]])), { code: '42501' });
  await workerWork((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [...lease(claims[0]), 'synthetic_stop', 'Synthetic attempt stopped.']));
});

test('worker reads require a live lease and cannot cross tenants or mutate analytical records', async () => {
  const flow = await reportFixture(account, { finalSection: true }); const id = rendererId();
  await enqueue(flow.reportId, id); const job = await claim(id);
  const otherUser = await createAccount(owner, { permissions });
  const other = { ...otherUser, ...await signIn({ identifier: otherUser.username, password: otherUser.password }) };
  const otherFlow = await reportFixture(other);
  assert.equal((await worker.query('SELECT id FROM sample_reports')).rowCount, 0);
  await workerWork(async (client) => {
    await client.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [account.organizationId, account.userId]);
    assert.equal((await client.query('SELECT id FROM sample_reports')).rowCount, 0);
    const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease(job))).rows[0];
    const report = await loadReport(client, identity, flow.reportId);
    assert.equal(report.report.id, flow.reportId); assert.equal(report.metrics.definition.queryCount, 8); assert.equal(report.metrics.capture.queryCount, 3);
    assert.equal((await client.query('SELECT id FROM sample_reports WHERE organization_id=$1', [other.organizationId])).rowCount, 0);
    assert.equal((await client.query('SELECT id FROM sample_reports WHERE id=$1', [otherFlow.reportId])).rowCount, 0);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [other.organizationId]);
    assert.equal((await client.query('SELECT id FROM sample_reports')).rowCount, 0);
  });
  assert.equal((await worker.query('SELECT id FROM sample_reports')).rowCount, 0);
  await assert.rejects(worker.query('UPDATE template_values SET number_value=7 WHERE false'), { code: '42501' });
  await assert.rejects(workerWork(async (client) => {
    await client.query('CREATE TEMP TABLE synthetic_trigger_probe(id uuid) ON COMMIT DROP');
    await client.query('CREATE TRIGGER synthetic_trigger_probe BEFORE INSERT ON synthetic_trigger_probe FOR EACH ROW EXECUTE FUNCTION laboratory_guard_datasheet()');
  }), { code: '42501' });
  await assert.rejects(worker.query('SELECT report_pdf_enqueue($1,$2)', [flow.reportId, id]), { code: '42501' });
  await assert.rejects(workerWork((client) => client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', [other.organizationId, job.job_id, job.lease_token])), { code: '40001' });
  await workerWork((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [...lease(job), 'synthetic_stop', 'Synthetic attempt stopped.']));
});

test('expired leases preserve attempt history, reject stale publication and recover without duplicate artifacts', async () => {
  const flow = await reportFixture(); const id = rendererId(); await enqueue(flow.reportId, id);
  const first = await claim(id);
  await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [first.organization_id, first.job_id, randomUUID(), fakePdf])), { code: '40001' });
  await owner.query('UPDATE report_pdf_jobs SET lease_expires_at=started_at+(clock_timestamp()-started_at)/2 WHERE organization_id=$1 AND id=$2', [first.organization_id, first.job_id]);
  const second = await claim(id); assert.equal(second.job_id, first.job_id); assert.equal(second.attempt_number, 2);
  await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(first), fakePdf])), { code: '40001' });
  await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(second), Buffer.from('invalid PDF')])), { code: '23514' });
  let status = await work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true });
  assert.deepEqual(status.history.map((attempt) => attempt.status), ['expired', 'running']); assert.equal(status.job.status, 'running');
  await workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(second), fakePdf]));
  const file = await work((client, identity) => reportPdfFile(client, identity, flow.reportId), { readOnly: true });
  assert.deepEqual(file.content, fakePdf); assert.equal(file.checksum, createHash('sha256').update(fakePdf).digest('hex'));
  status = await work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true });
  assert.equal(status.job.status, 'succeeded'); assert.equal(status.history[1].status, 'succeeded');
  await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(second), fakePdf])), { code: '40001' });
  await assert.rejects(owner.query('UPDATE report_pdf_artifacts SET content=content WHERE organization_id=$1 AND report_id=$2', [account.organizationId, flow.reportId]), { code: '55000' });
  await assert.rejects(owner.query("UPDATE report_pdf_attempts SET error_message='Changed history' WHERE organization_id=$1 AND job_id=$2 AND attempt_number=1", [account.organizationId, first.job_id]), { code: '55000' });
  await assert.rejects(owner.query('UPDATE report_pdf_jobs SET requested_by=requested_by WHERE organization_id=$1 AND id=$2', [account.organizationId, first.job_id]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM report_pdf_jobs WHERE organization_id=$1 AND id=$2', [account.organizationId, first.job_id]), { code: '55000' });
});

test('retry delays and five-attempt limits preserve every failure and reject missing error details', async () => {
  const flow = await reportFixture(); const id = rendererId(); const jobId = await enqueue(flow.reportId, id);
  for (let number = 1; number <= 5; number += 1) {
    const job = await claim(id); assert.equal(job.attempt_number, number);
    if (number === 1) await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,true)', [...lease(job), 'synthetic_failure', null])), { code: '23514' });
    await workerWork((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,true)', [...lease(job), 'synthetic_failure', 'Synthetic transient failure.']));
    assert.equal(await claim(id), undefined);
    if (number < 5) await owner.query('UPDATE report_pdf_jobs SET available_at=clock_timestamp() WHERE organization_id=$1 AND id=$2', [account.organizationId, jobId]);
  }
  const state = await work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true });
  assert.equal(state.job.status, 'failed'); assert.equal(state.job.attempts, 5); assert.equal(state.history.length, 5);
  assert.ok(state.history.every((attempt) => attempt.status === 'failed' && attempt.completedAt && attempt.errorCode === 'synthetic_failure'));
  assert.equal((await work((client, identity) => enqueueReportPdf(client, identity, flow.reportId))).job.id, jobId);
  await assert.rejects(work((client, identity) => reportPdfFile(client, identity, flow.reportId), { readOnly: true }), { code: 'report_pdf_not_ready' });
});

test('permissions are checked again after rendering and revoked requesters cannot publish or read PDFs', async () => {
  const user = await createAccount(owner, { permissions });
  const selected = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  const completedFlow = await reportFixture(selected); const completedId = rendererId();
  await enqueue(completedFlow.reportId, completedId, selected); const completedJob = await claim(completedId);
  await workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(completedJob), fakePdf]));
  const flow = await reportFixture(selected); const id = rendererId(); await enqueue(flow.reportId, id, selected); const job = await claim(id);
  await workerWork((client) => client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', lease(job)));
  await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='samples.manage'", [selected.organizationId, selected.roleId]);
  await assert.rejects(workerWork((client) => client.query('SELECT report_pdf_complete($1,$2,$3,$4)', [...lease(job), fakePdf])), { code: '42501' });
  await assert.rejects(work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true }, selected), { code: 'workflow_action_denied' });
  assert.equal((await work((client) => client.query('SELECT id FROM report_pdf_artifacts WHERE report_id=$1', [completedFlow.reportId]), { readOnly: true }, selected)).rowCount, 0);
  await assert.rejects(work((client, identity) => reportPdfFile(client, identity, completedFlow.reportId), { readOnly: true }, selected), { code: 'workflow_action_denied' });
  await workerWork((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)', [...lease(job), 'report_print_permission_revoked', 'Print permission was revoked.']));
  assert.equal((await owner.query('SELECT 1 FROM report_pdf_artifacts WHERE organization_id=$1 AND report_id=$2', [selected.organizationId, flow.reportId])).rowCount, 0);
});

test('the dedicated worker renders and stores the shared frozen document independently of the enqueue request', async () => {
  const flow = await reportFixture(account, { finalSection: true });
  const renderer = await loadReportRenderer();
  assert.equal((await work((client, identity) => reportPdfStatus(client, identity, flow.reportId), { readOnly: true })).job, null);
  const queued = await work((client, identity) => enqueueReportPdf(client, identity, flow.reportId));
  assert.equal(queued.job.status, 'queued'); assert.equal(queued.job.rendererId, renderer.rendererId);
  const result = await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() });
  assert.deepEqual(result, { jobId: queued.job.id, status: 'succeeded' });
  const file = await work((client, identity) => reportPdfFile(client, identity, flow.reportId), { readOnly: true });
  assert.ok(file.byteLength > 5000); assert.equal(file.content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(file.checksum, createHash('sha256').update(file.content).digest('hex')); assert.match(file.filename, /-v1\.pdf$/);
  assert.equal((await work((client, identity) => enqueueReportPdf(client, identity, flow.reportId))).job.id, queued.job.id);
  assert.equal(await processNextReportJob({ pool: worker, renderer, workerId: randomUUID() }), null);
});
