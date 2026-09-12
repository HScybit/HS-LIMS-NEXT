import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareReportFlow } from '../helpers/report-flow.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { generateReports, loadReport, reportOptions } from '../../src/reports/service.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { loadDefinitions, loadCaptures, loadCapture } from '../../src/templates/loader.js';
import { createReportTemplate } from '../helpers/reports.js';

const owner = ownerPool(); let account;
const work = (callback, options) => withSession(account.token, callback, { csrfToken: account.csrfToken, ...options });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'test_requests.allocate', 'datasheets.execute'] });
  account = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

test('reports pin exact zero results, source scientific interpretation, print choices and actor history across later edits', async () => {
  const flow = await prepareReportFlow(owner, account);
  const input = { ...flow.input, printConfig: { xMargin: 0, printHeader: false } };
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, input));
  assert.equal(generated.items.length, 1);
  const id = generated.items[0].id;
  const report = await work((client, identity) => loadReport(client, identity, id), { readOnly: true });
  assert.equal(report.results[0].submissionId, flow.submission.submissionId);
  assert.equal(report.results[0].finalResult, '0');
  assert.equal(report.results[0].measurementUnit, 'mg/L');
  assert.equal(report.results[0].decisionOutcome, 'Within synthetic limit');
  assert.equal(report.results[0].analystName, 'Synthetic Analyst');
  assert.equal(report.report.generatedBy, account.userId);
  assert.equal(report.printConfig.xMargin, '0'); assert.equal(report.printConfig.printHeader, false);
  assert.equal(report.metrics.definition.queryCount, 8);
  const exactTime = (await owner.query(`SELECT report.registered_at=sample.registered_at AS registered, chosen.completed_at=request.completed_at AS completed
    FROM sample_reports report JOIN samples sample ON sample.organization_id=report.organization_id AND sample.id=report.sample_id
    JOIN sample_report_tests chosen ON chosen.organization_id=report.organization_id AND chosen.report_id=report.id
    JOIN test_requests request ON request.organization_id=chosen.organization_id AND request.id=chosen.test_request_id
    WHERE report.organization_id=$1 AND report.id=$2`, [account.organizationId, id])).rows[0];
  assert.deepEqual(exactTime, { registered: true, completed: true });
  const title = flow.template.records.fields[0];
  await work((client, identity) => editTemplate(client, identity, flow.template.versionId, 1, { type: 'configureField', columnId: title.columnId, widget: 'text_widget', label: 'Changed future report' }));
  await owner.query("UPDATE methods_of_analysis SET name='Changed method', revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.fixture.method.id]);
  await owner.query("UPDATE measurement_units SET symbol='Changed unit', revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, flow.fixture.unit.id]);
  const after = await work((client, identity) => loadReport(client, identity, id), { readOnly: true });
  assert.deepEqual(after.results, report.results);
  assert.equal(after.model.fieldsById[title.id].label, 'CERTIFICATE OF ANALYSIS');
  await assert.rejects(owner.query('DELETE FROM sample_reports WHERE organization_id=$1 AND id=$2', [account.organizationId, id]), { code: '55000' });
  await assert.rejects(owner.query('UPDATE sample_report_tests SET product_name=$3 WHERE organization_id=$1 AND report_id=$2', [account.organizationId, id, 'Changed']), { code: '55000' });
  await assert.rejects(owner.query('UPDATE sample_report_print_settings SET x_margin=5 WHERE organization_id=$1 AND report_id=$2', [account.organizationId, id]), { code: '55000' });
});

test('concurrent generation retries return one immutable revision and explicit regeneration retains the report number', async () => {
  const flow = await prepareReportFlow(owner, account);
  const runs = await Promise.all([1, 2].map(() => work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input))));
  assert.equal(runs[0].items[0].id, runs[1].items[0].id);
  assert.equal(runs.filter((run) => run.replayed).length, 1);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, printConfig: { xMargin: 2 } })), { code: 'report_request_reused' });
  const next = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID() }));
  assert.equal(next.items[0].revision, 2); assert.equal(next.items[0].reportNumber, runs[0].items[0].reportNumber);
  assert.notEqual(next.items[0].id, runs[0].items[0].id);
});

test('missing approval, foreign selections, stale samples and failed print writes cannot create partial reports or events', async () => {
  const flow = await prepareReportFlow(owner, account);
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, selectedSampleTestIds: [randomUUID()] })), { code: 'invalid_report_test' });
  await assert.rejects(work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, revision: 2 })), { code: 'stale_sample' });
  const incomplete = await prepareReportFlow(owner, account, { complete: false });
  await assert.rejects(work((client, identity) => generateReports(client, identity, incomplete.sample.id, incomplete.input)), { code: 'report_tests_unapproved' });
  await assert.rejects(work((client, identity) => generateReports({ query: async (statement, parameters) => {
    if (/insert into "sample_report_print_settings"/i.test(typeof statement === 'string' ? statement : statement.text)) throw new Error('Synthetic print settings failure');
    return client.query(statement, parameters);
  } }, identity, flow.sample.id, flow.input)), (error) => /Synthetic print settings failure/.test((error.cause ?? error).message));
  assert.equal((await owner.query('SELECT id FROM sample_reports WHERE organization_id=$1 AND sample_id=$2', [account.organizationId, flow.sample.id])).rowCount, 0);
  assert.equal((await owner.query('SELECT id FROM sample_events WHERE organization_id=$1 AND id=$2', [account.organizationId, flow.input.requestId])).rowCount, 0);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const foreign = await createAccount(owner, { permissions: ['samples.read', 'samples.manage'] });
  const session = await signIn({ identifier: foreign.username, password: foreign.password });
  await assert.rejects(withSession(session.token, (client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true }), { status: 404 });
  await assert.rejects(withSession(session.token, (client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true }), { status: 404 });
});

test('print capability belongs to the requested sample and cannot leak from another workflow in the same tenant', async () => {
  const other = await createAccount(owner, { organizationId: account.organizationId, permissions: [] });
  const allowed = await prepareReportFlow(owner, account, { printRoleId: account.roleId });
  const denied = await prepareReportFlow(owner, account, { printRoleId: other.roleId });
  const access = await work((client) => client.query('SELECT report_can_print($1) AS allowed, report_can_print($2) AS denied, report_can_print($3) AS missing', [allowed.sample.id, denied.sample.id, randomUUID()]), { readOnly: true });
  assert.deepEqual(access.rows[0], { allowed: true, denied: false, missing: false });
  await assert.rejects(work((client, identity) => generateReports(client, identity, denied.sample.id, denied.input)), { code: 'workflow_action_denied' });
  const generated = await work((client, identity) => generateReports(client, identity, allowed.sample.id, allowed.input));
  assert.equal(generated.items.length, 1);
});

test('report owner locks allow an in-flight request foreign-key check to finish without a sample/request deadlock', async () => {
  const flow = await prepareReportFlow(owner, account);
  const requestLocked = Promise.withResolvers(); const reportStarted = Promise.withResolvers(); const finishRequest = Promise.withResolvers();
  const requestWrite = work(async (client) => {
    const { rows: [connection] } = await client.query('SELECT pg_backend_pid() AS pid');
    await client.query('SELECT id FROM test_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE', [account.organizationId, flow.requestId]);
    requestLocked.resolve(connection.pid);
    await finishRequest.promise;
    await client.query('SELECT id FROM samples WHERE organization_id=$1 AND id=$2 FOR KEY SHARE', [account.organizationId, flow.sample.id]);
  });
  const requestPid = await requestLocked.promise;
  const generating = work(async (client, identity) => {
    const { rows: [connection] } = await client.query('SELECT pg_backend_pid() AS pid');
    reportStarted.resolve(connection.pid);
    return generateReports(client, identity, flow.sample.id, flow.input);
  });
  try {
    const reportPid = await reportStarted.promise;
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await owner.query('SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked', [requestPid, reportPid]);
      if (result.rows[0].blocked) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'Report generation must wait for the existing request write.');
  } finally { finishRequest.resolve(); }
  const [, report] = await Promise.all([requestWrite, generating]);
  assert.equal(report.items.length, 1);
});

test('report sections reload repeated frozen values with eight definition and three capture reads', async () => {
  const flow = await prepareReportFlow(owner, account, { finalSection: true });
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(options.canGenerate, true); assert.equal(options.products[0].tests[0].hasSubmission, true);
  assert.equal(options.templates.some((template) => template.id === flow.template.templateId), true);
  const generated = await work((client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const statements = [];
  const report = await work((client, identity) => loadReport({ query: (statement, values) => {
    statements.push(typeof statement === 'string' ? statement : statement.text);
    return client.query(statement, values);
  } }, identity, generated.items[0].id), { readOnly: true });
  assert.equal(report.results[0].source, 'section');
  assert.equal(report.results[0].finalResult, '0');
  const capture = report.finalCaptures[flow.sheet.template_instance_id];
  assert.equal(capture.occurrences.length, 3);
  assert.equal(capture.sectionRoots.length, 1);
  assert.equal(capture.values.filter((value) => value.state === 'present' && value.numberValue === '0').length, 6);
  assert.equal(report.datasheetModels[capture.versionId].sectionsById[capture.sectionRoots[0].sectionId].name, 'Final results');
  assert.equal(report.metrics.definition.queryCount, 8); assert.equal(report.metrics.capture.queryCount, 3);
  assert.equal(statements.filter((statement) => /\bfrom "?template_(?:versions|sections|rows|columns|fields|options|expressions|repeat_groups)"?\b/i.test(statement)).length, 8);
  assert.equal(statements.filter((statement) => /\bfrom template_(?:instances|occurrences|values)\b/i.test(statement)).length, 3);
  await work((client, identity) => editTemplate(client, identity, flow.fixture.template.versionId, 3,
    { type: 'configureSection', id: flow.fixture.template.records.sections[0].id, name: 'Future section', isFinalResult: false }));
  const later = await work((client, identity) => loadReport(client, identity, generated.items[0].id), { readOnly: true });
  assert.deepEqual(later.finalCaptures, report.finalCaptures); assert.deepEqual(later.datasheetModels, report.datasheetModels);
});

test('batch loaders keep stable field identities separate across versions and reject unavailable tenant captures', async () => {
  const first = await prepareReportFlow(owner, account, { finalSection: true });
  const second = await prepareReportFlow(owner, account, { finalSection: true });
  const field = first.fixture.template.records.fields[0];
  await work((client, identity) => editTemplate(client, identity, first.fixture.template.versionId, 3,
    { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, label: 'Future field', displayScale: 7, padDecimals: false }));
  const captureRows = (await owner.query('SELECT id, version_id, revision FROM template_instances WHERE organization_id=$1 AND id=ANY($2::uuid[])', [account.organizationId, [first.sheet.template_instance_id, second.sheet.template_instance_id]])).rows;
  const ids = [...captureRows.map((capture) => capture.version_id), first.fixture.template.versionId];
  const loaded = await work((client, identity) => loadDefinitions(client, identity.organization_id, ids), { readOnly: true });
  assert.equal(loaded.metrics.queryCount, 8); assert.equal(loaded.definitions.size, 3);
  const fieldId = first.fixture.template.records.fields[0].id;
  const oldVersion = captureRows.find((capture) => capture.id === first.sheet.template_instance_id).version_id;
  assert.equal(loaded.definitions.get(oldVersion).model.fieldsById[fieldId].numeric.displayScale, 2);
  assert.equal(loaded.definitions.get(first.fixture.template.versionId).model.fieldsById[fieldId].numeric.displayScale, 7);
  const captures = await work((client, identity) => loadCaptures(client, identity.organization_id, captureRows.map((capture) => ({ instanceId: capture.id, revision: capture.revision }))), { readOnly: true });
  assert.equal(captures.metrics.queryCount, 3); assert.equal(captures.captures.size, 2);
  const upperCase = await work((client, identity) => loadCapture(client, identity.organization_id, first.sheet.template_instance_id.toUpperCase()), { readOnly: true });
  assert.equal(upperCase.instance.id, first.sheet.template_instance_id);
  assert.notEqual(captures.captures.get(first.sheet.template_instance_id).occurrences[0].id, captures.captures.get(second.sheet.template_instance_id).occurrences[0].id);
  await assert.rejects(work((client, identity) => loadCaptures(client, identity.organization_id, [{ instanceId: randomUUID() }]), { readOnly: true }), { code: 'capture_not_found' });
  await assert.rejects(work((client, identity) => loadCaptures(client, identity.organization_id, [{ instanceId: first.sheet.template_instance_id, revision: 0 }]), { readOnly: true }), { code: 'invalid_revision' });
});

test('product and parameter reports preserve duplicate product-line identity and batch distinct report templates', async () => {
  const flow = await prepareReportFlow(owner, account, { finalSection: true, productLines: 2 });
  const secondTemplate = await work(createReportTemplate);
  const options = await work((client, identity) => reportOptions(client, identity, flow.sample.id), { readOnly: true });
  assert.equal(options.products.length, 2); assert.equal(options.products[0].name, options.products[1].name);
  const templateSelections = options.products.map((product, index) => ({ key: product.id, templateId: index === 0 ? flow.template.templateId : secondTemplate.templateId }));
  const statements = [];
  const grouped = await work((client, identity) => generateReports({ query: (statement, values) => {
    statements.push(typeof statement === 'string' ? statement : statement.text);
    return client.query(statement, values);
  } }, identity, flow.sample.id, { ...flow.input, reportType: 'product_wise', templateSelections }));
  assert.equal(grouped.items.length, 2); assert.equal(new Set(grouped.items.map((report) => report.reportNumber)).size, 2);
  assert.equal(statements.filter((statement) => /^select .*\bfrom "template_(?:versions|sections|rows|columns|fields|options|expressions|repeat_groups)"/i.test(statement)).length, 8);
  assert.equal(statements.filter((statement) => /\bfrom template_(?:instances|occurrences|values)\b/i.test(statement)).length, 3);
  const contents = await Promise.all(grouped.items.map((item) => work((client, identity) => loadReport(client, identity, item.id), { readOnly: true })));
  assert.equal(new Set(contents.map((report) => report.results[0].id)).size, 2);
  assert.equal(new Set(contents.map((report) => report.results[0].instanceId)).size, 2);
  assert.equal(new Set(contents.map((report) => report.model.version.templateId)).size, 2);
  const parameters = await work((client, identity) => generateReports(client, identity, flow.sample.id, { ...flow.input, requestId: randomUUID(), reportType: 'parameter_wise', templateSelections }));
  assert.equal(parameters.items.length, 2);
  assert.deepEqual(new Set(parameters.items.map((report) => report.groupKey)), new Set(flow.input.selectedSampleTestIds.map((id) => `parameter:${id}`)));
});
