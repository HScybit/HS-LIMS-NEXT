import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, issueReport, listReports } from '../../src/reports/service.js';

const owner = ownerPool(); let account;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

async function finalizedReport(options) {
  const flow = await prepareReportFlow(owner, account, options);
  const generated = await work(account, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, finalizeSample: true }));
  return { flow, report: generated.items[0] };
}

test('issuing a finalized, approved report stamps the actor/time once and records a real event', async () => {
  const { flow, report } = await finalizedReport();
  const issued = await work(account, (client, identity) => issueReport(client, identity, report.id, report.revision));
  assert.equal(issued.item.status, 'issued');
  assert.equal(issued.item.issuedBy, account.userId);
  assert.ok(issued.item.issuedAt instanceof Date);
  const stored = (await owner.query('SELECT status,issued_by,issued_at FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, report.id])).rows[0];
  assert.deepEqual(stored, { status: 'issued', issued_by: account.userId, issued_at: issued.item.issuedAt });
  const event = (await owner.query("SELECT event_type,actor_user_id,description FROM sample_events WHERE organization_id=$1 AND sample_id=$2 AND event_type='report_issued'", [account.organizationId, flow.sample.id])).rows[0];
  assert.deepEqual(event, { event_type: 'report_issued', actor_user_id: account.userId, description: `Issued report ${report.reportNumber} (revision ${report.revision}).` });
  const list = await work(account, (client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(list.items.find((item) => item.id === report.id).status, 'issued');
});

test('a draft report cannot be issued before its sample reports are finalized', async () => {
  const flow = await prepareReportFlow(owner, account);
  const draft = await work(account, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(draft.items[0].isFinalized, false);
  await assert.rejects(work(account, (client, identity) => issueReport(client, identity, draft.items[0].id, draft.items[0].revision)), { code: 'report_not_finalized' });
  const stored = (await owner.query('SELECT status FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, draft.items[0].id])).rows[0];
  assert.equal(stored.status, 'draft');
});

test('an already-issued report cannot be issued again, and a stale revision is rejected', async () => {
  const { report } = await finalizedReport();
  await work(account, (client, identity) => issueReport(client, identity, report.id, report.revision));
  await assert.rejects(work(account, (client, identity) => issueReport(client, identity, report.id, report.revision)), { code: 'report_already_issued' });
  const { report: other } = await finalizedReport();
  await assert.rejects(work(account, (client, identity) => issueReport(client, identity, other.id, other.revision + 1)), { code: 'stale_report' });
});

test('issuing requires the print/approval workflow gate, tenant scope and cannot forge the actor or bypass the approval check directly', async () => {
  const { report } = await finalizedReport();
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] });
  await Object.assign(reader, await signIn({ identifier: reader.username, password: reader.password }));
  await assert.rejects(work(reader, (client, identity) => issueReport(client, identity, report.id, report.revision)), { status: 403 });
  const foreign = await createAccount(owner, { permissions: ['samples.manage'] });
  await Object.assign(foreign, await signIn({ identifier: foreign.username, password: foreign.password }));
  await assert.rejects(work(foreign, (client, identity) => issueReport(client, identity, report.id, report.revision)), { code: 'report_not_found' });
  // The immutability guard still protects every identity/content column from direct SQL,
  // regardless of who issues the report — only status/issued_by/issued_at may ever change.
  await assert.rejects(owner.query("UPDATE sample_reports SET report_number='FORGED-0001' WHERE organization_id=$1 AND id=$2", [account.organizationId, report.id]), { code: '55000' });
  await assert.rejects(owner.query('UPDATE sample_reports SET revision=99 WHERE organization_id=$1 AND id=$2', [account.organizationId, report.id]), { code: '55000' });
  // A permitted application session cannot skip the same approval/finalisation checks the
  // service enforces by issuing SQL directly: this draft was never finalized, so the guard
  // still rejects flipping its status even though the actor otherwise has samples.manage.
  const flow = await prepareReportFlow(owner, account);
  const draft = await work(account, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  await assert.rejects(work(account, (client) => client.query("UPDATE sample_reports SET status='issued', issued_by=$3, issued_at=now() WHERE organization_id=$1 AND id=$2",
    [account.organizationId, draft.items[0].id, account.userId])), { code: '42501' });
  const draftStored = (await owner.query('SELECT status FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, draft.items[0].id])).rows[0];
  assert.equal(draftStored.status, 'draft');
  await assert.rejects(owner.query('DELETE FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, report.id]), { code: '55000' });
});
