import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, issueReport, reissueSampleReports, listReports } from '../../src/reports/service.js';

const owner = ownerPool(); let account;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

async function issuedReport(options) {
  const flow = await prepareReportFlow(owner, account, { enableReissue: true, showSampleReissue: true, ...options });
  const generated = await work(account, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, finalizeSample: true }));
  const report = generated.items[0];
  await work(account, (client, identity) => issueReport(client, identity, report.id, report.revision));
  return { flow, report };
}

test('reissuing clones the exact frozen selection and assets, edits only the customer fields, and never supersedes the original', async () => {
  const { flow, report } = await issuedReport();
  const originalTests = (await owner.query('SELECT * FROM sample_report_tests WHERE organization_id=$1 AND report_id=$2 ORDER BY display_order', [account.organizationId, report.id])).rows;
  const originalAssets = (await owner.query('SELECT * FROM sample_report_assets WHERE organization_id=$1 AND report_id=$2', [account.organizationId, report.id])).rows[0];
  const originalPrint = (await owner.query('SELECT * FROM sample_report_print_settings WHERE organization_id=$1 AND report_id=$2', [account.organizationId, report.id])).rows[0];
  const reissued = await work(account, (client, identity) => reissueSampleReports(client, identity, flow.sample.id, { customerName: 'Reissued Customer Name' }));
  assert.equal(reissued.items.length, 1);
  const clone = reissued.items[0];
  assert.equal(clone.status, 'issued');
  assert.equal(clone.isReissued, true);
  assert.equal(clone.reissueSourceId, report.id);
  assert.equal(clone.groupKey, report.groupKey);
  assert.equal(clone.revision, report.revision + 1);
  assert.equal(clone.isFinalized, true);
  const stored = (await owner.query('SELECT * FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, clone.id])).rows[0];
  assert.equal(stored.customer_name, 'Reissued Customer Name');
  assert.equal(stored.customer_address, report.customerAddress ?? stored.customer_address);
  assert.equal(stored.report_number, report.reportNumber);
  assert.ok(stored.reissued_by === account.userId);
  assert.ok(stored.reissued_at instanceof Date);
  const cloneTests = (await owner.query('SELECT sample_test_id,sample_product_id,test_request_id,submission_id,specification_id,decision_limit_id,display_order,product_code,product_name,request_number,analyst_name,is_accredited,request_status,datasheet_status,completed_at FROM sample_report_tests WHERE organization_id=$1 AND report_id=$2 ORDER BY display_order', [account.organizationId, clone.id])).rows;
  const originalComparable = originalTests.map(({ organization_id, report_id, ...rest }) => rest);
  assert.deepEqual(cloneTests, originalComparable);
  const cloneAssets = (await owner.query('SELECT header_version_id,footer_version_id,nabl_header_version_id,nabl_footer_version_id,css_version_id FROM sample_report_assets WHERE organization_id=$1 AND report_id=$2', [account.organizationId, clone.id])).rows[0];
  assert.deepEqual(cloneAssets, { header_version_id: originalAssets.header_version_id, footer_version_id: originalAssets.footer_version_id,
    nabl_header_version_id: originalAssets.nabl_header_version_id, nabl_footer_version_id: originalAssets.nabl_footer_version_id, css_version_id: originalAssets.css_version_id });
  const clonePrint = (await owner.query('SELECT page_size,scale,x_margin,is_landscape,print_header,print_footer FROM sample_report_print_settings WHERE organization_id=$1 AND report_id=$2', [account.organizationId, clone.id])).rows[0];
  assert.deepEqual(clonePrint, { page_size: originalPrint.page_size, scale: originalPrint.scale, x_margin: originalPrint.x_margin,
    is_landscape: originalPrint.is_landscape, print_header: originalPrint.print_header, print_footer: originalPrint.print_footer });
  const originalStillIssued = (await owner.query('SELECT status FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, report.id])).rows[0];
  assert.equal(originalStillIssued.status, 'issued');
  const list = await work(account, (client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(list.items.find((item) => item.id === report.id).reissueLabel, null);
  assert.equal(list.items.find((item) => item.id === clone.id).reissueLabel, 'Reissue 1');
});

test('a second reissue is labelled Reissue 2 and still sources from the original, not the first reissue', async () => {
  const { flow, report } = await issuedReport();
  const first = await work(account, (client, identity) => reissueSampleReports(client, identity, flow.sample.id, {}));
  const second = await work(account, (client, identity) => reissueSampleReports(client, identity, flow.sample.id, {}));
  assert.equal(first.items[0].reissueSourceId, report.id);
  assert.equal(second.items[0].reissueSourceId, report.id);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const list = await work(account, (client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(list.items.find((item) => item.id === first.items[0].id).reissueLabel, 'Reissue 1');
  assert.equal(list.items.find((item) => item.id === second.items[0].id).reissueLabel, 'Reissue 2');
});

test('reissue is rejected when the sample category has not enabled it, when the workflow state hides it, and when there is nothing issued to reissue', async () => {
  const { flow: categoryDisabled } = await issuedReport({ enableReissue: false, showSampleReissue: true });
  await assert.rejects(work(account, (client, identity) => reissueSampleReports(client, identity, categoryDisabled.sample.id, {})), { code: 'reissue_not_enabled' });
  // The show_sample_reissue flag only matters once a workflow state actually configures
  // capability roles: with none configured, download_report falls back to samples.manage
  // (like every other report action), so a role must be assigned here for the flag to bite.
  const { flow: workflowHidden } = await issuedReport({ enableReissue: true, showSampleReissue: false, printRoleId: account.roleId });
  await assert.rejects(work(account, (client, identity) => reissueSampleReports(client, identity, workflowHidden.sample.id, {})), { code: 'workflow_action_denied' });
  const draftFlow = await prepareReportFlow(owner, account, { enableReissue: true, showSampleReissue: true });
  await work(account, (client, identity) => generateReports(client, identity, draftFlow.sample.id, draftFlow.input));
  await assert.rejects(work(account, (client, identity) => reissueSampleReports(client, identity, draftFlow.sample.id, {})), { code: 'report_not_finalized' });
});

test('a forged reissue insert cannot skip the draft stage, and a completed reissue stays immutable to direct SQL', async () => {
  const { flow, report } = await issuedReport();
  // A permitted application session cannot fabricate an already-"issued" reissue by
  // raw SQL: every insert, reissue included, must still land as 'draft' first.
  await assert.rejects(work(account, (client, identity) => client.query(`INSERT INTO sample_reports(organization_id, id, sample_id, template_version_id, report_number, revision, report_type, group_key,
      generated_by, generated_event_id, sample_revision, sample_number, sample_type, sample_category_name, received_at, registered_at, description, is_finalized, is_nabl,
      is_reissued, reissue_source_id, reissue_batch_id, reissued_by, reissued_at, status)
    SELECT organization_id, gen_random_uuid(), sample_id, template_version_id, report_number, revision+5, report_type, group_key,
      $3, generated_event_id, sample_revision, sample_number, sample_type, sample_category_name, received_at, registered_at, description, false, is_nabl,
      true, id, gen_random_uuid(), $3, now(), 'issued'
    FROM sample_reports WHERE organization_id=$1 AND id=$2`, [identity.organization_id, report.id, identity.user_id])), { code: '42501' });
  const reissued = await work(account, (client, identity) => reissueSampleReports(client, identity, flow.sample.id, {}));
  const clone = reissued.items[0];
  await assert.rejects(owner.query("UPDATE sample_reports SET customer_name='Forged' WHERE organization_id=$1 AND id=$2", [account.organizationId, clone.id]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, clone.id]), { code: '55000' });
});
