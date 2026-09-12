import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture, changeRepeat } from '../../src/templates/capture.js';
import { requireCaptureWrite } from '../../src/templates/access.js';
import { addTestRequestMethod } from '../../src/test-requests/methods.js';

const owner = ownerPool(); let creator; let analyst;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
const load = (id, options) => work(analyst, (client, identity) => loadDatasheet(client, identity, id, options), { readOnly: true });
before(async () => {
  creator = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'templates.manage', 'settings.manage'] });
  analyst = await createAccount(owner, { organizationId: creator.organizationId, permissions: ['datasheets.execute'] });
  for (const user of [creator, analyst]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });
const entryInput = (field, row, value) => ({ fieldId: field.id, occurrenceId: row.id, state: value === null ? 'empty' : 'present', ...(value === null ? {} : { value }) });
const resultField = (sheet) => Object.values(sheet.model.fieldsById).find((field) => field.widget === 'result_widget');
const entries = async (id) => (await owner.query(`SELECT entry.*,subject.test_request_id,value.number_value,value.state,value.saved_by,value.saved_at
  FROM job_result_entries entry JOIN datasheet_subjects subject ON subject.organization_id=entry.organization_id AND subject.id=entry.subject_id
  JOIN template_values value ON value.organization_id=entry.organization_id AND value.instance_id=entry.instance_id AND value.field_id=entry.field_id
    AND value.occurrence_id=entry.occurrence_id AND value.revision=entry.value_revision
  WHERE entry.organization_id=$1 AND entry.datasheet_id=$2 ORDER BY entry.value_revision,entry.position`, [creator.organizationId, id])).rows;

test('job inputs retain exact subjects, input order, zero, clear history and real actors without inventing child capture values', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { manualParent: true, resultWidget: true });
  const initial = await load(flow.job.datasheetId); const field = resultField(initial);
  const rows = initial.capture.occurrences.filter((row) => row.subject);
  const requestId = rows[0].subject.testRequestId;
  const sameChild = rows.filter((row) => row.subject.testRequestId === requestId);
  const otherChild = rows.find((row) => row.subject.testRequestId !== requestId);
  const before = await owner.query('SELECT id,revision,status,latest_submission_id FROM datasheets WHERE organization_id=$1 AND test_request_id=ANY($2::uuid[]) ORDER BY id', [creator.organizationId, flow.requests.map((row) => row.id)]);
  await work(analyst, (client, identity) => saveCapture(client, identity, initial.capture.instance.id, initial.capture.revision,
    [entryInput(field, sameChild[1], '5'), entryInput(field, otherChild, '0'), entryInput(field, sameChild[0], '7.20')]));
  const saved = await load(flow.job.datasheetId); const history = await entries(flow.job.datasheetId);
  assert.deepEqual(history.map((row) => row.number_value), ['5', '0', '7.20']);
  assert.deepEqual(history.map((row) => row.position), [0, 1, 2]);
  assert.ok(history.every((row) => row.saved_by === analyst.userId));
  assert.equal(saved.dataContext.parametersByRequestId[requestId].finalResult, '7.20');
  assert.equal(saved.dataContext.parametersByRequestId[otherChild.subject.testRequestId].finalResult, '0');
  const after = await owner.query('SELECT id,revision,status,latest_submission_id FROM datasheets WHERE organization_id=$1 AND test_request_id=ANY($2::uuid[]) ORDER BY id', [creator.organizationId, flow.requests.map((row) => row.id)]);
  assert.deepEqual(after.rows, before.rows);
  await work(analyst, (client, identity) => saveCapture(client, identity, saved.capture.instance.id, saved.capture.revision, [entryInput(field, sameChild[0], null)]));
  const cleared = await load(flow.job.datasheetId);
  assert.equal(cleared.dataContext.parametersByRequestId[requestId].finalResult, null);
  assert.equal((await entries(flow.job.datasheetId)).at(-1).state, 'empty');
  assert.equal((await load(flow.job.datasheetId, { atRevision: saved.capture.revision })).dataContext.parametersByRequestId[requestId].finalResult, '7.20');
});

test('cloning and removing measurement rows preserve the last actual input instead of silently selecting copied values', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { manualParent: true, resultWidget: true });
  let sheet = await load(flow.job.datasheetId); const field = resultField(sheet);
  const outer = sheet.capture.occurrences.find((row) => row.groupId === flow.template.manualGroupId);
  const parameter = sheet.capture.occurrences.find((row) => row.subject && row.parentId === outer.id);
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [entryInput(field, parameter, '3')]));
  sheet = await load(flow.job.datasheetId);
  const copied = await work(analyst, (client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, sheet.capture.revision, { type: 'clone', occurrenceId: outer.id, withData: true }));
  assert.equal((await entries(flow.job.datasheetId)).length, 1);
  const copy = copied.occurrences.find((row) => row.subject?.testRequestId === parameter.subject.testRequestId && !sheet.capture.occurrences.some((prior) => prior.id === row.id));
  const changed = await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, copied.revision, [entryInput(field, copy, '9')]));
  await work(analyst, (client, identity) => changeRepeat(client, identity, sheet.capture.instance.id, changed.revision, { type: 'remove', occurrenceId: copy.parentId }));
  const latest = await load(flow.job.datasheetId);
  assert.equal(latest.dataContext.parametersByRequestId[parameter.subject.testRequestId].finalResult, '9');
  assert.equal((await entries(flow.job.datasheetId)).length, 2);
  assert.ok(!latest.capture.occurrences.some((row) => row.id === copy.id));
});

test('explicit final sections suppress source job-result propagation', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true, finalSection: true });
  const sheet = await load(flow.job.datasheetId); const field = resultField(sheet);
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    sheet.capture.occurrences.filter((row) => row.subject).map((row) => entryInput(field, row, '0'))));
  assert.equal((await entries(flow.job.datasheetId)).length, 0);
});

test('result provenance selects the current nonvoid child method while preserving its frozen summary subject', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true });
  const sheet = await load(flow.job.datasheetId); const row = sheet.capture.occurrences.find((item) => item.subject);
  const alternate = await createAlternateMethod(owner, creator, flow.source);
  const request = (await owner.query('SELECT revision FROM test_requests WHERE organization_id=$1 AND id=$2', [creator.organizationId, row.subject.testRequestId])).rows[0];
  const added = await work(analyst, (client, identity) => addTestRequestMethod(client, identity, row.subject.testRequestId, { revision: request.revision, methodId: alternate.id }));
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [entryInput(resultField(sheet), row, '4')]));
  assert.equal((await entries(flow.job.datasheetId))[0].child_datasheet_id, added.datasheetId);
  assert.equal((await entries(flow.job.datasheetId))[0].subject_id, row.subject.id);
});

test('foreign captures, forged receipts, missing provenance and unresolved numeric inputs fail atomically', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true });
  const sheet = await load(flow.job.datasheetId); const field = resultField(sheet); const row = sheet.capture.occurrences.find((item) => item.subject);
  for (const value of ['12abc', '1.234', 'NA']) await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [entryInput(field, row, value)])), { code: 'scientific_policy_unresolved' });
  await assert.rejects(work(analyst, (client) => client.query('INSERT INTO job_result_entries(organization_id) VALUES($1)', [creator.organizationId])), { code: '42501' });
  await assert.rejects(work(analyst, async (client) => {
    await requireCaptureWrite(client, sheet.capture.instance.id);
    await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [creator.organizationId, sheet.capture.instance.id]);
    await client.query(`INSERT INTO template_values(organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,number_value,lexical,saved_by)
      VALUES($1,$2,$3,$4,$5,$6,'numeric','present','entered',2,'2',$7)`, [creator.organizationId, sheet.capture.instance.id, sheet.model.version.id, field.id, row.id, sheet.capture.revision + 1, analyst.userId]);
  }), { code: '23514' });
  assert.equal((await load(flow.job.datasheetId)).capture.revision, sheet.capture.revision);
  assert.equal((await entries(flow.job.datasheetId)).length, 0);
  await assert.rejects(work(creator, (client) => client.query('SELECT laboratory_record_job_results($1,$2::uuid[],$3::uuid[],$4::integer[])', [sheet.capture.instance.id, [field.id], [row.id], [0]])), { code: '42501' });
});

test('concurrent job saves return a stale revision instead of deadlocking while selecting child results', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { resultWidget: true });
  const sheet = await load(flow.job.datasheetId); const row = sheet.capture.occurrences.find((item) => item.subject);
  let ready = 0; let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const attempt = (value) => work(analyst, async (client, identity) => {
    const query = client.query;
    client.query = async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('UPDATE template_instances SET revision = revision + 1')) {
        ready += 1; if (ready === 2) release();
        await barrier;
      }
      return query.apply(client, args);
    };
    try { return await saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision, [entryInput(resultField(sheet), row, value)]); }
    finally { client.query = query; }
  });
  const outcomes = await Promise.allSettled([attempt('2'), attempt('3')]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'stale_capture');
  assert.equal((await entries(flow.job.datasheetId)).length, 1);
});
