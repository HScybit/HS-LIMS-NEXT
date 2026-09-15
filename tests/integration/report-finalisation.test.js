import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { generateReports, loadReport, listReports, reportOptions } from '../../src/reports/service.js';

const owner = ownerPool(); let account;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
const sampleState = async (id) => (await owner.query('SELECT status,revision FROM samples WHERE organization_id=$1 AND id=$2', [account.organizationId, id])).rows[0];
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('finalized report sets reject new generations while preserving exact retries and history', async () => {
  const flow = await prepareReportFlow(owner, account);
  const draft = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(draft.reportsFinalized, false);
  const input = { ...flow.input, requestId: randomUUID(), finalizeSample: true };
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(generated.reportsFinalized, true);
  const before = await work((client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  for (const finalizeSample of [false, true]) {
    await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id,
      { ...input, revision: generated.sample.revision, requestId: randomUUID(), finalizeSample })), { code: 'report_already_finalized' });
    assert.deepEqual(await work((client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true }), before);
    assert.deepEqual(await sampleState(flow.sample.id), { status: 'completed', revision: generated.sample.revision });
  }
  const replay = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(replay.replayed, true); assert.equal(replay.items[0].id, generated.items[0].id);
  const oldDraft = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(oldDraft.replayed, true); assert.equal(oldDraft.items[0].id, draft.items[0].id);
  assert.equal(oldDraft.items[0].isFinalized, false); assert.equal(oldDraft.reportsFinalized, true);
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(options.canGenerate, false); assert.equal(options.reportsFinalized, true);
});

test('finalisation atomically completes the sample and pins actual evidence for every group without issuing or inventing workflow transitions', async () => {
  const flow = await prepareReportFlow(owner, account, { productLines: 2 });
  const workflowBefore = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rows;
  const draft = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  assert.equal(draft.items[0].isFinalized, false);
  assert.deepEqual(await sampleState(flow.sample.id), { status: 'registered', revision: 1 });
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  const input = { ...flow.input, requestId: randomUUID(), finalizeSample: true, reportType: 'product_wise',
    templateSelections: options.products.map((product) => ({ key: product.id, templateId: flow.template.templateId })) };
  const result = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((report) => report.isFinalized && report.status === 'draft'));
  assert.deepEqual(result.sample, { id: flow.sample.id, revision: 2, status: 'completed' });
  assert.deepEqual(await sampleState(flow.sample.id), { status: 'completed', revision: 2 });
  const evidence = (await owner.query(`SELECT completion.previous_revision,completion.completed_revision,completion.finalized_by,
    completion.finalized_at=event.occurred_at AS event_time,completion.finalized_at=report.generated_at AS report_time,
    event.event_type,report.issued_by,report.issued_at FROM sample_report_finalizations completion
    JOIN sample_events event ON event.organization_id=completion.organization_id AND event.id=completion.event_id
    JOIN sample_reports report ON report.organization_id=completion.organization_id AND report.generated_event_id=completion.event_id
    WHERE completion.organization_id=$1 AND completion.event_id=$2`, [account.organizationId, input.requestId])).rows;
  assert.equal(evidence.length, 2);
  for (const row of evidence) assert.deepEqual(row, { previous_revision: 1, completed_revision: 2, finalized_by: account.userId,
    event_time: true, report_time: true, event_type: 'reports_finalized', issued_by: null, issued_at: null });
  assert.deepEqual((await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rows, workflowBefore);
  for (const item of result.items) {
    const loaded = await work((client, identity) => loadReport(client, identity, item.id), { readOnly: true });
    assert.equal(loaded.report.isFinalized, true);
    assert.equal(loaded.report.sampleRevision, 1);
    assert.equal(loaded.results[0].finalResult, '0');
  }
  const history = await work((client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(history.items.filter((report) => report.isFinalized).length, 2);
  assert.equal(history.items.find((report) => report.id === draft.items[0].id).isFinalized, false);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id,
    { ...flow.input, requestId: randomUUID(), revision: 2 })), { code: 'report_already_finalized' });
  assert.deepEqual(await sampleState(flow.sample.id), { status: 'completed', revision: 2 });
});

test('concurrent retries complete once and reject changed finalisation intent or a separate stale generation', async () => {
  const flow = await prepareReportFlow(owner, account);
  const input = { ...flow.input, finalizeSample: true };
  const attempts = await Promise.all([1, 2].map(() => work((client, identity) => generateReports(client, identity, flow.sample.id, input))));
  assert.equal(attempts[0].items[0].id, attempts[1].items[0].id);
  assert.equal(attempts.filter((result) => result.replayed).length, 1);
  assert.deepEqual(attempts[0].sample, attempts[1].sample);
  assert.deepEqual(await sampleState(flow.sample.id), { status: 'completed', revision: 2 });
  assert.equal((await owner.query('SELECT * FROM sample_report_finalizations WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rowCount, 1);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input)), { code: 'report_request_reused' });
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...input, requestId: randomUUID() })), { code: 'stale_sample' });
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id,
    { ...input, requestId: randomUUID(), revision: 2 })), { code: 'report_already_finalized' });
  // Simulate a later sample edit without inventing another report finalization.
  await owner.query('UPDATE samples SET revision=3 WHERE organization_id=$1 AND id=$2', [account.organizationId, flow.sample.id]);
  const replay = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(replay.sample.revision, 3);
  assert.equal(replay.items[0].id, attempts[0].items[0].id);
});

test('completed sample status and allocated draft numbers do not finalize a report set', async () => {
  const flow = await prepareReportFlow(owner, account);
  await owner.query("UPDATE samples SET status='completed',revision=2 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.sample.id]);
  const input = { ...flow.input, revision: 2 };
  const first = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(first.reportsFinalized, false); assert.equal(first.items[0].isFinalized, false);
  const second = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...input, requestId: randomUUID() }));
  assert.equal(second.items[0].reportNumber, first.items[0].reportNumber); assert.equal(second.items[0].revision, 2);
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(options.canGenerate, true); assert.equal(options.reportsFinalized, false);
  assert.equal((await owner.query('SELECT 1 FROM sample_report_finalizations WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rowCount, 0);
});

test('the database rejects generation after finalization even when the application check is bypassed', async () => {
  const flow = await prepareReportFlow(owner, account);
  await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, finalizeSample: true }));
  const title = flow.template.records.fields[0];
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1,
    { type: 'configureField', columnId: title.columnId, widget: 'text_widget', label: 'Changed after report finalization' }));
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  const input = { ...flow.input, revision: options.sample.revision, requestId: randomUUID(), reportType: 'product_wise',
    templateSelections: options.products.map(product => ({ key: product.id, templateId: flow.template.templateId })) };
  const history = await work((client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true });
  const templates = async () => (await owner.query('SELECT id,status,number FROM template_versions WHERE organization_id=$1 ORDER BY id', [account.organizationId])).rows;
  const sequence = async () => (await owner.query("SELECT period_key,next_value FROM number_sequences WHERE organization_id=$1 AND sequence_key='sample_report' ORDER BY period_key", [account.organizationId])).rows;
  const beforeTemplates = await templates(); const beforeSequence = await sequence(); let bypassed = false; let constraint;
  await assert.rejects(work((client, identity) => generateReports({ query: async (statement, parameters) => {
    const query = typeof statement === 'string' ? statement : statement.text;
    if (/AS finalized\b/.test(query)) { bypassed = true; return { rows: [{ finalized: false }], rowCount: 1 }; }
    try { return await client.query(statement, parameters); }
    catch (error) { if (/^\s*INSERT INTO sample_reports\b/i.test(query)) constraint = error.constraint; throw error; }
  } }, identity, flow.sample.id, input)), { code: 'report_already_finalized' });
  assert.equal(bypassed, true); assert.equal(constraint, 'report_already_finalized');
  assert.deepEqual(await templates(), beforeTemplates); assert.deepEqual(await sequence(), beforeSequence);
  assert.deepEqual(await work((client, identity) => listReports(client, identity, flow.sample.id), { readOnly: true }), history);
  assert.equal((await owner.query('SELECT 1 FROM sample_events WHERE organization_id=$1 AND id=$2', [account.organizationId, input.requestId])).rowCount, 0);
});

test('a generation waiting on the sample lock rechecks committed finalization', async () => {
  const flow = await prepareReportFlow(owner, account);
  const held = Promise.withResolvers(); const release = Promise.withResolvers(); const started = Promise.withResolvers();
  let generating;
  const finalizing = work(async (client, identity) => {
    const { rows: [connection] } = await client.query('SELECT pg_backend_pid() AS pid');
    const result = await generateReports(client, identity, flow.sample.id, { ...flow.input, finalizeSample: true });
    held.resolve({ result, pid: connection.pid }); await release.promise; return result;
  });
  finalizing.catch(held.reject);
  try {
    const first = await held.promise;
    generating = work(async (client, identity) => {
      const { rows: [connection] } = await client.query('SELECT pg_backend_pid() AS pid'); started.resolve(connection.pid);
      return generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID(), revision: first.result.sample.revision });
    });
    generating.catch(started.reject);
    const outcomes = Promise.allSettled([finalizing, generating]);
    const pid = await started.promise; let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await owner.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [first.pid, pid])).rows[0].blocked) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true); release.resolve();
    const [finalized, rejected] = await outcomes;
    assert.equal(finalized.status, 'fulfilled'); assert.equal(rejected.status, 'rejected'); assert.equal(rejected.reason.code, 'report_already_finalized');
    assert.deepEqual(await sampleState(flow.sample.id), { status: 'completed', revision: first.result.sample.revision });
    assert.equal((await owner.query('SELECT 1 FROM sample_reports WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rowCount, first.result.items.length);
  } finally { release.resolve(); await Promise.allSettled([finalizing, ...(generating ? [generating] : [])]); }
});

test('failures before or after sample completion roll back every report, event and completion and preserve a retry', async () => {
  const flow = await prepareReportFlow(owner, account);
  const input = { ...flow.input, finalizeSample: true };
  for (const afterCompletion of [false, true]) {
    await assert.rejects(work((client, identity) => generateReports({ query: async (statement, parameters) => {
      const query = typeof statement === 'string' ? statement : statement.text;
      const fail = afterCompletion ? /SELECT report_finalize_sample/.test(query) : /insert into "sample_report_print_settings"/i.test(query);
      if (fail && !afterCompletion) throw new Error('Synthetic finalisation failure');
      const result = await client.query(statement, parameters);
      if (fail) throw new Error('Synthetic finalisation failure');
      return result;
    } }, identity, flow.sample.id, input)), (error) => /Synthetic finalisation failure/.test((error.cause ?? error).message));
    assert.deepEqual(await sampleState(flow.sample.id), { status: 'registered', revision: 1 });
    for (const table of ['sample_reports', 'sample_events', 'sample_report_finalizations']) {
      const column = table === 'sample_reports' ? 'generated_event_id' : table === 'sample_events' ? 'id' : 'event_id';
      assert.equal((await owner.query(`SELECT 1 FROM ${table} WHERE organization_id=$1 AND ${column}=$2`, [account.organizationId, input.requestId])).rowCount, 0);
    }
  }
  const retry = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(retry.sample.revision, 2);
});

test('direct SQL cannot commit incomplete finalisation or alter recorded completion evidence', async () => {
  const flow = await prepareReportFlow(owner, account);
  const input = { ...flow.input, finalizeSample: true };
  await assert.rejects(work((client, identity) => generateReports({ query: (statement, parameters) => {
    if (typeof statement === 'string' && /SELECT report_finalize_sample/.test(statement)) return Promise.resolve({ rows: [{ revision: 2 }] });
    return client.query(statement, parameters);
  } }, identity, flow.sample.id, input)), { constraint: 'report_finalization_complete' });
  await assert.rejects(work((client) => client.query(`INSERT INTO sample_events(organization_id,id,sample_id,event_type,actor_user_id,description)
    VALUES($1,$2,$3,'reports_finalized',$4,'Forged completion')`, [account.organizationId, input.requestId, flow.sample.id, account.userId])), { constraint: 'report_finalization_complete' });
  await assert.rejects(work((client) => client.query(`INSERT INTO sample_report_finalizations(organization_id,event_id,sample_id,previous_revision,completed_revision,finalized_by,finalized_at,transaction_id)
    VALUES($1,$2,$3,1,2,$4,now(),pg_current_xact_id())`, [account.organizationId, input.requestId, flow.sample.id, account.userId])), { code: '42501' });
  const result = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  await assert.rejects(owner.query('UPDATE sample_report_finalizations SET finalized_at=now() WHERE organization_id=$1 AND event_id=$2', [account.organizationId, input.requestId]), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM sample_report_finalizations WHERE organization_id=$1 AND event_id=$2', [account.organizationId, input.requestId]), { code: '55000' });
  await assert.rejects(owner.query('UPDATE sample_reports SET is_finalized=false WHERE organization_id=$1 AND id=$2', [account.organizationId, result.items[0].id]), { code: '55000' });
});

test('finalisation keeps result approval, workflow role, tenant and cancellation gates', async () => {
  const incomplete = await prepareReportFlow(owner, account, { complete: false });
  await assert.rejects(work((client, identity) => generateReports(client, identity, incomplete.sample.id, { ...incomplete.input, finalizeSample: true })), { code: 'report_tests_unapproved' });
  const other = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  const denied = await prepareReportFlow(owner, account, { printRoleId: other.roleId });
  await assert.rejects(work((client, identity) => generateReports(client, identity, denied.sample.id, { ...denied.input, finalizeSample: true })), { code: 'workflow_action_denied' });
  const flow = await prepareReportFlow(owner, account);
  const foreign = await createAccount(owner, { permissions: ['samples.manage'] });
  const session = await signIn({ identifier: foreign.username, password: foreign.password });
  await assert.rejects(withSession(session.token, (client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, finalizeSample: true }), { csrfToken: session.csrfToken }), { code: 'sample_not_found' });
  await owner.query("UPDATE samples SET status='cancelled',revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.sample.id]);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, revision: 2, finalizeSample: true })), { code: 'sample_cancelled' });
});
