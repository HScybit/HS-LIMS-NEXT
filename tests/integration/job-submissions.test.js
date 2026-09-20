import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture } from '../../src/templates/capture.js';
import { submitDatasheet } from '../../src/datasheets/submit.js';
import { reportCandidates } from '../../src/reports/service.js';

const owner = ownerPool(); let creator; let analyst;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
const load = (id) => work(analyst, (client, identity) => loadDatasheet(client, identity, id), { readOnly: true });
before(async () => {
  creator = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'templates.manage', 'settings.manage'] });
  analyst = await createAccount(owner, { organizationId: creator.organizationId, permissions: ['datasheets.execute'] });
  for (const user of [creator, analyst]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

async function fill(id, values = []) {
  const sheet = await load(id); const field = Object.values(sheet.model.fieldsById).find((item) => item.widget === 'result_widget');
  const rows = sheet.capture.occurrences.filter((row) => row.subject);
  const required = Object.values(sheet.model.fieldsById).filter((item) => item.widget === 'number_widget' && item.required)
    .flatMap((item) => sheet.capture.occurrences.filter((row) => row.groupId === item.repeatGroupId)
      .map((row) => ({ fieldId: item.id, occurrenceId: row.id, state: 'present', value: '0' })));
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    [...required, ...values.map((value, index) => ({ fieldId: field.id, occurrenceId: rows[index].id, state: value === null ? 'empty' : 'present', ...(value === null ? {} : { value }) }))]));
  return { ...await load(id), parameterRows: rows };
}
const submit = (sheet) => work(analyst, (client, identity) => submitDatasheet(client, identity, sheet.datasheet.id, { revision: sheet.datasheet.revision, captureRevision: sheet.capture.revision }));
const memberRows = async (parentId) => (await owner.query(`SELECT member.test_request_id,submission.*,sheet.template_instance_id AS child_capture_id,request.status AS request_status
  FROM job_submission_members member JOIN datasheet_submissions submission ON submission.organization_id=member.organization_id AND submission.id=member.submission_id
  JOIN datasheets sheet ON sheet.organization_id=submission.organization_id AND sheet.id=submission.datasheet_id
  JOIN test_requests request ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id
  WHERE member.organization_id=$1 AND member.parent_submission_id=$2 ORDER BY request.job_member_position`, [creator.organizationId, parentId])).rows;

test('job submission freezes the actual summary and records separate child results with eight definition and three capture reads', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true });
  const sheet = await fill(flow.job.datasheetId, ['0', '4.20']);
  const submitted = await submit(sheet); const members = await memberRows(submitted.submission.id);
  assert.equal(submitted.submission.measurementUnitId, null);
  assert.equal(submitted.metrics.definition.queryCount, 9); assert.equal(submitted.metrics.capture.queryCount, 3);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((member) => member.number_value).sort(), ['0', '4.20']);
  for (const member of members) {
    assert.equal(member.source, 'result_widget'); assert.equal(member.source_datasheet_id, sheet.datasheet.id);
    assert.equal(member.instance_id, sheet.capture.instance.id); assert.notEqual(member.instance_id, member.child_capture_id);
    assert.equal(member.capture_revision, submitted.captureRevision); assert.equal(member.submitted_by, analyst.userId);
    assert.equal(member.request_status, 'under_review'); assert.equal(member.unit_symbol, 'mg/L'); assert.ok(member.job_result_entry_id);
    assert.equal(member.specification_id, sheet.parameterRows.find((row) => row.subject.testRequestId === member.test_request_id).subject.specificationId);
  }
  const candidates = await work(creator, (client, identity) => reportCandidates(client, identity, flow.sample.id), { readOnly: true });
  assert.deepEqual(candidates.map((row) => row.numberValue).sort(), ['0', '4.20']);
  assert.ok(candidates.every((row) => row.instanceId === sheet.capture.instance.id && row.source === 'result_widget'));
  await assert.rejects(submit(sheet), { code: 'datasheet_closed' });
});

test('a group can submit existing child capture values and retains independently submitted child evidence', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst);
  const childIds = (await owner.query('SELECT sheet.id FROM datasheets sheet JOIN test_requests request ON request.organization_id=sheet.organization_id AND request.id=sheet.test_request_id WHERE request.organization_id=$1 AND request.parent_test_request_id=$2 ORDER BY request.job_member_position', [creator.organizationId, flow.job.id])).rows.map((row) => row.id);
  const independent = await submit(await fill(childIds[0]));
  await fill(childIds[1]);
  const submitted = await submit(await fill(flow.job.datasheetId));
  const members = await memberRows(submitted.submission.id);
  assert.ok(members.some((member) => member.id === independent.submission.id));
  assert.ok(members.every((member) => member.source === 'column' && member.source_datasheet_id === member.datasheet_id && member.instance_id === member.child_capture_id));
  assert.ok(members.every((member) => member.number_value === '0'));
  const captures = await owner.query('SELECT status FROM template_instances WHERE organization_id=$1 AND id=ANY($2::uuid[])', [creator.organizationId, members.map((member) => member.instance_id)]);
  assert.ok(captures.rows.every((row) => row.status === 'frozen'));
});

test('a cleared child result rolls back the parent freeze and every child submission, then a corrected retry succeeds', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true });
  let sheet = await fill(flow.job.datasheetId, ['8', '9']);
  const field = Object.values(sheet.model.fieldsById).find((item) => item.widget === 'result_widget');
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    [{ fieldId: field.id, occurrenceId: sheet.parameterRows[1].id, state: 'empty' }]));
  const cleared = await load(flow.job.datasheetId);
  await assert.rejects(submit(cleared), { code: 'job_member_result_required' });
  const after = await load(flow.job.datasheetId);
  assert.equal(after.capture.instance.status, 'editing'); assert.equal(after.capture.revision, cleared.capture.revision);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM datasheet_submissions WHERE organization_id=$1 AND source_datasheet_id=$2', [creator.organizationId, flow.job.datasheetId])).rows[0].count, 0);
  sheet = await fill(flow.job.datasheetId, ['8', '0']);
  assert.equal((await memberRows((await submit(sheet)).submission.id)).length, 2);
});
