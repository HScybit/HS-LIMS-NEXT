import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSubjectJob } from '../helpers/job-subjects.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDatasheet } from '../../src/datasheets/service.js';
import { saveCapture, changeRepeat, createCapture } from '../../src/templates/capture.js';
import { requireCaptureWrite } from '../../src/templates/access.js';
import { editTemplate } from '../../src/templates/authoring.js';

const owner = ownerPool(); let creator; let analyst;
const work = (user, callback, options = {}) => withSession(user.token, callback, { csrfToken: user.csrfToken, ...options });
const load = (id, options) => work(analyst, (client, identity) => loadDatasheet(client, identity, id, options), { readOnly: true });
before(async () => {
  creator = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'test_requests.allocate', 'templates.manage', 'settings.manage'] });
  analyst = await createAccount(owner, { organizationId: creator.organizationId, permissions: ['datasheets.execute'] });
  for (const user of [creator, analyst]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('parameter capture binds each real child, loads in fourteen statements, and keeps zero and sibling formulas separate', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst);
  let statementCount = 0;
  const sheet = await work(analyst, async (client, identity) => {
    const query = client.query;
    client.query = (...args) => { statementCount += 1; return query.apply(client, args); };
    try { return await loadDatasheet(client, identity, flow.job.datasheetId); } finally { client.query = query; }
  }, { readOnly: true });
  assert.equal(statementCount, 14); assert.equal(sheet.metrics.definition.queryCount, 9); assert.equal(sheet.metrics.capture.queryCount, 3); assert.equal(sheet.metrics.metadataQueryCount, 2);
  const parameters = sheet.capture.occurrences.filter((row) => row.subject);
  assert.equal(parameters.length, 2);
  assert.deepEqual(new Set(parameters.map((row) => row.subject.testRequestId)), new Set(flow.requests.map((row) => row.id)));
  assert.deepEqual(new Set(sheet.dataContext.results.map((row) => row.parameterName)), new Set(['Synthetic concentration', 'Second synthetic concentration']));
  const raw = Object.values(sheet.model.fieldsById).find((field) => field.alias === 'raw_0');
  const formula = Object.values(sheet.model.fieldsById).find((field) => field.alias === 'result_0');
  await work(analyst, (client, identity) => saveCapture(client, identity, sheet.capture.instance.id, sheet.capture.revision,
    parameters.map((row, index) => ({ fieldId: raw.id, occurrenceId: row.id, state: 'present', value: index * 5 }))));
  const saved = await load(flow.job.datasheetId);
  assert.deepEqual(parameters.map((row) => saved.capture.values.find((value) => value.fieldId === formula.id && value.occurrenceId === row.id).numberValue), ['0', '10']);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM datasheet_subjects WHERE organization_id=$1 AND datasheet_id=$2', [creator.organizationId, flow.job.datasheetId])).rows[0].count, 2);
});

test('manual measurement clones retain subject links and data, with immutable removed history', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { manualParent: true });
  const sheet = await load(flow.job.datasheetId); const instanceId = sheet.capture.instance.id;
  const outer = sheet.capture.occurrences.find((row) => row.groupId === flow.template.manualGroupId);
  const raw = Object.values(sheet.model.fieldsById).find((field) => field.alias === 'raw_0');
  const parameterRows = sheet.capture.occurrences.filter((row) => row.subject);
  const saved = await work(analyst, (client, identity) => saveCapture(client, identity, instanceId, sheet.capture.revision,
    parameterRows.map((row, index) => ({ fieldId: raw.id, occurrenceId: row.id, state: 'present', value: index }))));
  const copied = await work(analyst, (client, identity) => changeRepeat(client, identity, instanceId, saved.revision, { type: 'clone', occurrenceId: outer.id, withData: true }));
  const addedOuter = copied.occurrences.find((row) => row.groupId === flow.template.manualGroupId && !sheet.capture.occurrences.some((before) => before.id === row.id));
  const addedParameters = copied.occurrences.filter((row) => row.parentId === addedOuter.id);
  assert.equal(addedParameters.length, 2); assert.ok(addedParameters.every((row) => row.subject?.id));
  assert.deepEqual(new Set(addedParameters.map((row) => row.subject.testRequestId)), new Set(flow.requests.map((row) => row.id)));
  const beforeRemoval = await load(flow.job.datasheetId);
  assert.equal(beforeRemoval.capture.occurrences.filter((row) => row.subject).length, 6);
  await work(analyst, (client, identity) => changeRepeat(client, identity, instanceId, copied.revision, { type: 'remove', occurrenceId: addedOuter.id }));
  const latest = await load(flow.job.datasheetId); const historical = await load(flow.job.datasheetId, { atRevision: copied.revision });
  assert.equal(latest.capture.occurrences.filter((row) => row.subject).length, 4);
  assert.equal(historical.capture.occurrences.filter((row) => row.subject).length, 6);
  for (const row of addedParameters) assert.equal(historical.capture.values.find((value) => value.occurrenceId === row.id && value.fieldId === raw.id).state, 'present');
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM datasheet_subjects WHERE organization_id=$1 AND datasheet_id=$2', [creator.organizationId, flow.job.datasheetId])).rows[0].count, 6);
});

test('fixed parameter rows, readonly source widgets, foreign bindings and unbound captures cannot forge child data', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst);
  const other = await prepareSubjectJob(owner, creator, analyst);
  const sheet = await load(flow.job.datasheetId); const instanceId = sheet.capture.instance.id;
  const parameter = sheet.capture.occurrences.find((row) => row.subject);
  const contextual = Object.values(sheet.model.fieldsById).find((field) => field.widget === 'tr_data_widget');
  await assert.rejects(work(analyst, (client, identity) => changeRepeat(client, identity, instanceId, sheet.capture.revision, { type: 'clone', occurrenceId: parameter.id, withData: false })), { code: 'fixed_parameter_subject' });
  await assert.rejects(work(analyst, (client, identity) => saveCapture(client, identity, instanceId, sheet.capture.revision,
    [{ fieldId: contextual.id, occurrenceId: parameter.id, state: 'present', value: 'Forged parameter' }])), { code: 'readonly_field' });
  await assert.rejects(work(analyst, (client, identity) => createCapture(client, identity, sheet.model.version.id)), { code: 'parameter_context_required' });
  await assert.rejects(work(analyst, async (client) => {
    await requireCaptureWrite(client, instanceId);
    await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [creator.organizationId, instanceId]);
    const occurrenceId = randomUUID();
    await client.query(`INSERT INTO template_occurrences(organization_id,instance_id,version_id,id,group_id,parent_id,position,created_revision)
      VALUES($1,$2,$3,$4,$5,$6,99,$7)`, [creator.organizationId, instanceId, sheet.model.version.id, occurrenceId, parameter.groupId, parameter.parentId, sheet.capture.revision + 1]);
    await client.query(`INSERT INTO datasheet_subjects(organization_id,datasheet_id,instance_id,version_id,occurrence_id,test_request_id,specification_id,created_revision,created_by)
      SELECT $1,$2,$3,$4,$5,id,specification_id,$6,$7 FROM test_requests WHERE organization_id=$1 AND id=$8`,
    [creator.organizationId, flow.job.datasheetId, instanceId, sheet.model.version.id, occurrenceId, sheet.capture.revision + 1, analyst.userId, other.requests[0].id]);
  }), { code: '23514' });
  assert.equal((await load(flow.job.datasheetId)).capture.revision, sheet.capture.revision);
});

test('later template loop changes and master labels leave existing subject identity and scientific labels frozen', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst);
  const before = await load(flow.job.datasheetId);
  const changed = await work(creator, (client, identity) => editTemplate(client, identity, flow.template.versionId, flow.template.revision,
    { type: 'configureSection', id: flow.template.parameterSectionId, name: 'Updated draft container', cssClass: '', visible: true, isHeader: false, isFooter: false, isFinalResult: false, isParameterLoop: false }));
  assert.equal(Object.values(changed.model.groupsById).filter((group) => group.source === 'test_requests').length, 0);
  await owner.query("UPDATE test_parameters SET name='Changed later master label',revision=revision+1 WHERE organization_id=$1 AND id=$2", [creator.organizationId, flow.source.parameter.id]);
  const after = await load(flow.job.datasheetId);
  assert.deepEqual(after.capture.occurrences, before.capture.occurrences);
  assert.equal(after.model.sectionsById[flow.template.parameterSectionId].isParameterLoop, true);
  assert.ok(after.capture.occurrences.some((row) => row.subject?.parameterName === 'Synthetic concentration'));
});

// Q6 (2026-09-18): a job carrying two test requests for the SAME parameter (here, tested via two
// different methods) keeps them as distinct rows rather than grouping/collapsing them by parameter.
test('a job with the same parameter tested by two methods keeps both as distinct, separately identified rows', async () => {
  const flow = await prepareSubjectJob(owner, creator, analyst, { duplicateParameterMethod: true });
  assert.equal(flow.requests.length, 3);
  const sheet = await load(flow.job.datasheetId);
  const parameters = sheet.capture.occurrences.filter((row) => row.subject);
  assert.equal(parameters.length, 3);
  assert.deepEqual(new Set(parameters.map((row) => row.subject.testRequestId)), new Set(flow.requests.map((row) => row.id)));
  const sameParameter = sheet.dataContext.results.filter((row) => row.parameterName === 'Synthetic concentration');
  assert.equal(sameParameter.length, 2);
  assert.notEqual(sameParameter[0].testRequestId, sameParameter[1].testRequestId);
  assert.notEqual(sameParameter[0].methodName, sameParameter[1].methodName);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM datasheet_subjects WHERE organization_id=$1 AND datasheet_id=$2', [creator.organizationId, flow.job.datasheetId])).rows[0].count, 3);
});
