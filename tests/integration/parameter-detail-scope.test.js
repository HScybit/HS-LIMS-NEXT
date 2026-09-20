import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareScalarParameterDetailReport } from '../helpers/parameter-details.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, transaction } from '../../src/db/pool.js';
import { loadReport } from '../../src/reports/service.js';
import { createReportWorkerPool } from '../../src/reports/worker.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('a worker leased for a scalar job result cannot read unused cached details from the shared parent capture', async () => {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'] });
  Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
  const work = (action) => withSession(user.token, action, { csrfToken: user.csrfToken });
  const { sheet, reportId } = await prepareScalarParameterDetailReport(owner, user);
  const rendererId = createHash('sha256').update(randomUUID()).digest('hex');
  await work((client) => client.query('SELECT report_pdf_enqueue($1,$2)', [reportId, rendererId]));
  process.loadEnvFile('.env.worker.local'); const worker = createReportWorkerPool(); let job;
  try {
    job = await transaction(async (client) => (await client.query('SELECT * FROM report_pdf_claim($1,$2)', [rendererId, randomUUID()])).rows[0], { pool: worker });
    await transaction(async (client) => {
      const identity = (await client.query('SELECT * FROM report_pdf_begin_read($1,$2,$3)', [job.organization_id, job.job_id, job.lease_token])).rows[0];
      const report = await loadReport(client, identity, reportId);
      assert.equal(report.results[0].source, 'result_widget'); assert.deepEqual(report.finalCaptures, {});
      assert.equal((await client.query("SELECT field_id FROM template_values WHERE instance_id=$1 AND value_type='parameter_detail'", [sheet.capture.instance.id])).rowCount, 0);
      assert.equal((await client.query('SELECT * FROM template_parameter_detail_items WHERE instance_id=$1', [sheet.capture.instance.id])).rowCount, 0);
    }, { pool: worker });
  } finally {
    if (job) await transaction((client) => client.query('SELECT report_pdf_fail($1,$2,$3,$4,$5,false)',
      [job.organization_id, job.job_id, job.lease_token, 'synthetic_scope_complete', 'Synthetic scope check complete']), { pool: worker });
    await worker.end();
  }
});
