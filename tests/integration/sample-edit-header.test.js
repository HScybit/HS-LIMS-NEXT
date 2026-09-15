import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { prepareSampleLineFlow } from '../helpers/sample-lines.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, database } from '../../src/db/pool.js';
import { customerQuotations } from '../../src/db/master-schema.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSampleHeader } from '../../src/samples/update.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { generateReports, loadReport } from '../../src/reports/service.js';
import { requestWorkflowTransition } from '../../src/workflows/requests.js';

const owner = ownerPool();
let manager; let reader; let allocator; let creator; let foreign;
const permissions = ['samples.create', 'samples.manage', 'samples.read', 'templates.manage', 'masters.manage', 'datasheets.execute', 'test_requests.allocate', 'settings.manage'];
const work = (account, action, options) => withSession(account.token, action, { csrfToken: account.csrfToken, ...options });
async function account(options = {}) {
  const result = await createAccount(owner, { permissions, ...options });
  return { ...result, ...await signIn({ identifier: result.username, password: result.password }) };
}
before(async () => {
  manager = await account();
  reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  allocator = await account({ organizationId: manager.organizationId, permissions: ['test_requests.allocate'] });
  creator = await account({ organizationId: manager.organizationId, permissions: ['samples.create'] });
  foreign = await account();
});
after(async () => { await closePool(); await owner.end(); });

async function setup(type = 'internal', options = {}, extra = {}) {
  const fixture = await createLaboratoryFixture(owner, manager, options);
  Object.assign(fixture.registration, { sampleType: type, customerId: fixture.customer.id, customerAddress: 'Original address', ...extra });
  if (type === 'quality_control') fixture.registration.iqcType = 'retest';
  if (type === 'complaint') fixture.registration.products[0].tests[0].isRetest = true;
  const sample = await work(manager, (client, identity) => registerSample(client, identity, fixture.registration));
  return { fixture, sample };
}
const edit = (sample, changes, user = manager) => work(user, (client, identity) => updateSampleHeader(client, identity, sample.id, { revision: sample.revision, ...changes }));
const row = async sample => (await owner.query('SELECT *,received_at::text AS received_exact,due_at::text AS due_exact,retention_due_on::text AS retention_due_on FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0];
const events = async sample => (await owner.query('SELECT * FROM sample_events WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [manager.organizationId, sample.id])).rows;
const sqlError = code => error => (error.code ?? error.cause?.code) === code;
async function quote(customerId, extra = {}, user = manager) {
  return (await database(owner).insert(customerQuotations).values({ organizationId: user.organizationId, customerId, quotationNumber: randomUUID(),
    quotationDate: '2026-01-01', totalAmount: '0', status: 'approved', ...extra }).returning())[0];
}

test('header edits retain omitted values, exact decimals, identity, workflow and selected lines with one actual actor event', async () => {
  const { sample } = await setup(); const before = await row(sample);
  const lines = await owner.query('SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [manager.organizationId, sample.id]);
  const changed = await edit(sample, { customerAddress: '  Revised address  ', customerReference: '', quantity: '1.00000000000000001',
    totalAmount: '0', currencyCode: 'inr', description: null, modeOfReceipt: 'Courier', receivedByName: 'New receiver', collectionDetails: 'Collected carefully' });
  assert.equal(changed.revision, 2); const after = await row(sample);
  assert.equal(after.customer_address, 'Revised address'); assert.equal(after.customer_reference, '');
  assert.equal(after.quantity, '1.00000000000000001'); assert.equal(after.total_amount, '0'); assert.equal(after.currency_code, 'INR');
  assert.equal(after.description, null); assert.equal(after.received_by_name, 'New receiver');
  for (const field of ['sample_number', 'sample_type', 'registered_by', 'registered_at', 'received_exact', 'due_exact', 'sample_category_id', 'template_instance_id', 'retention_due_on', 'customer_name']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.deepEqual((await owner.query('SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2 ORDER BY id', [manager.organizationId, sample.id])).rows, lines.rows);
  const activity = (await events(sample)).filter(event => event.event_type === 'sample_updated');
  assert.equal(activity.length, 1); assert.equal(activity[0].actor_user_id, manager.userId); assert.equal(activity[0].description, 'Sample updated');
  assert.equal(activity[0].test_request_id, null); assert.equal(activity[0].datasheet_id, null);
});

for (const type of ['quality_control', 'amendment', 'complaint']) test(`${type} header whitelist ignores locked values before interpreting them`, async () => {
  const { sample } = await setup(type); const before = await row(sample);
  const updated = await edit(sample, { customerAddress: 'Edited special address', receivedAt: false, dueAt: {}, quantity: 'invalid',
    totalAmount: [], currencyCode: 12, receivedByName: { invalid: true }, modeOfReceipt: 'Post', collectionDetails: 'Updated collection',
    amendmentRemarks: 'Amendment reason', complaintRemarks: 'Complaint reason' });
  const after = await row(sample); assert.equal(updated.revision, 2); assert.equal(after.customer_address, 'Edited special address');
  for (const field of ['received_exact', 'due_exact', 'quantity', 'total_amount', 'currency_code', 'received_by_name']) assert.deepEqual(after[field], before[field], field);
  assert.equal(after.mode_of_receipt, type === 'amendment' ? 'Post' : before.mode_of_receipt);
  assert.equal(after.collection_details, type === 'amendment' ? 'Updated collection' : before.collection_details);
  assert.equal(after.amendment_remarks, type === 'amendment' ? 'Amendment reason' : before.amendment_remarks);
  assert.equal(after.complaint_remarks, type === 'complaint' ? 'Complaint reason' : before.complaint_remarks);
  const activity = await events(sample);
  const empty = await edit(updated, { totalAmount: false, receivedAt: 'invalid' });
  assert.equal(empty.revision, 2); assert.deepEqual(await row(sample), after); assert.deepEqual(await events(sample), activity);
});

test('changed customers and quotations require valid tenant relationships and clearing a customer clears its captured names', async () => {
  const { sample, fixture } = await setup('amendment');
  const other = await createLaboratoryFixture(owner, manager); const selected = await quote(other.customer.id);
  const draft = await quote(other.customer.id, { status: 'draft' }); const expired = await quote(other.customer.id, { validUntil: '2026-01-02' });
  const foreignFixture = await createLaboratoryFixture(owner, foreign); const foreignQuote = await quote(foreignFixture.customer.id, {}, foreign);
  const before = await row(sample);
  for (const input of [{ customerId: foreignFixture.customer.id }, { customerId: randomUUID() }, { customerQuotationId: selected.id },
    { customerId: other.customer.id, customerQuotationId: draft.id }, { customerId: other.customer.id, customerQuotationId: expired.id },
    { customerId: other.customer.id, customerQuotationId: foreignQuote.id }]) {
    await assert.rejects(edit(sample, input), { code: 'invalid_sample_reference' }); assert.deepEqual(await row(sample), before);
  }
  const updated = await edit(sample, { customerId: other.customer.id.toUpperCase(), customerQuotationId: selected.id.toUpperCase(), customerAddress: 'Different address' });
  const captured = await row(sample); assert.equal(captured.customer_id, other.customer.id); assert.equal(captured.customer_name, other.customer.name);
  assert.equal(captured.customer_legal_name, other.customer.legalName); assert.equal(captured.customer_quotation_id, selected.id);
  await assert.rejects(edit(updated, { customerId: fixture.customer.id }), { code: 'invalid_sample_reference' });
  const cleared = await edit(updated, { customerId: null, customerQuotationId: null, customerAddress: null });
  const result = await row(sample); assert.equal(cleared.revision, 3);
  for (const key of ['customer_id', 'customer_code', 'customer_name', 'customer_legal_name', 'customer_address', 'customer_quotation_id']) assert.equal(result[key], null, key);
});

test('unchanged inactive customers and expired quotations retain captured names and remain editable by UUID case', async () => {
  const { sample, fixture } = await setup(); const quotation = await quote(fixture.customer.id);
  const linked = await edit(sample, { customerQuotationId: quotation.id });
  await owner.query('UPDATE customers SET active=false,name=$3,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.customer.id, 'Later master name']);
  await owner.query("UPDATE customer_quotations SET status='expired' WHERE organization_id=$1 AND id=$2", [manager.organizationId, quotation.id]);
  const changed = await edit(linked, { customerId: fixture.customer.id.toUpperCase(), customerQuotationId: quotation.id.toUpperCase(), customerAddress: 'Updated retained address' });
  const result = await row(sample); assert.equal(result.customer_name, fixture.customer.name); assert.equal(result.customer_address, 'Updated retained address');
  const other = await setup(); await assert.rejects(edit(other.sample, { customerId: fixture.customer.id }), { code: 'invalid_sample_reference' });
  assert.equal(changed.revision, 3);
});

test('date edits preserve microseconds and explicit nulls, use actual instant changes for retention, and roll back invalid precision/ranges', async () => {
  const { sample, fixture } = await setup();
  const updated = await edit(sample, { receivedAt: '2026-09-13T05:30:00.123456+05:30', dueAt: '2026-09-13T00:00:00.123456Z' });
  let current = await row(sample); assert.equal(current.received_exact, '2026-09-13 00:00:00.123456+00'); assert.equal(current.due_exact, current.received_exact);
  assert.equal(current.retention_due_on, '2026-10-13');
  await owner.query('UPDATE sample_categories SET retention_days=45,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.category.id]);
  const sameInstant = await edit(updated, { receivedAt: '2026-09-13T00:00:00.123456Z' });
  assert.equal((await row(sample)).retention_due_on, '2026-10-13');
  for (const input of [{ dueAt: '2026-09-13T00:00:00.123455Z' }, { receivedAt: '2026-09-15T00:00:00Z' }, { totalAmount: '1e-999999', currencyCode: 'INR' }]) {
    const before = await row(sample); const activity = await events(sample);
    await assert.rejects(edit(sameInstant, input), { code: 'invalid_sample' });
    assert.deepEqual(await row(sample), before); assert.deepEqual(await events(sample), activity);
  }
  const cleared = await edit(sameInstant, { dueAt: null, receivedAt: '2026-09-14T00:00:00Z' });
  current = await row(sample); assert.equal(current.retention_due_on, '2026-10-29'); assert.equal(current.due_exact, null);
  const changed = await edit(cleared, { description: '' }); assert.equal(changed.revision, cleared.revision + 1);
});

test('permission, tenant, workflow flags, malformed input and stale saves reject without changing a sample', async () => {
  const { sample } = await setup(); const before = await row(sample);
  for (const user of [reader, allocator, creator]) await assert.rejects(edit(sample, { customerAddress: 'Denied' }, user), { status: 403 });
  await assert.rejects(edit(sample, { customerAddress: 'Denied' }, foreign), { status: 404 });
  await assert.rejects(edit({ id: randomUUID(), revision: 1 }, {}), { status: 404 });
  for (const changes of [{ revision: 2 }, { organizationId: foreign.organizationId }, { sampleNumber: 'Changed' }, { products: [] },
    { customerAddress: null }, { description: 'Bad\0text' }, { receivedAt: 'bad' }, { totalAmount: null, currencyCode: 'INR' }]) {
    await assert.rejects(edit(sample, changes)); assert.deepEqual(await row(sample), before);
  }
  const denied = await setup('internal', { editRoleId: reader.roleId });
  const hidden = await setup('internal', { editRoleId: manager.roleId, showSampleEdit: false });
  for (const value of [denied, hidden]) {
    const initial = await row(value.sample);
    await assert.rejects(edit(value.sample, { customerAddress: 'Denied' }), { code: 'workflow_action_denied' });
    assert.deepEqual(await row(value.sample), initial);
  }
  const changed = await edit(sample, { customerAddress: 'Saved' });
  await assert.rejects(edit(sample, { customerAddress: 'Stale' }), { code: 'sample_changed' }); assert.equal(changed.revision, 2);
});

test('simultaneous header saves commit one complete change and one actor event', async () => {
  const { sample } = await setup();
  const outcomes = await Promise.allSettled([edit(sample, { customerAddress: 'First' }), edit(sample, { customerAddress: 'Second' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'sample_changed');
  assert(['First', 'Second'].includes((await row(sample)).customer_address));
  assert.equal((await events(sample)).filter(event => event.event_type === 'sample_updated').length, 1);
});

test('a completed workflow transaction wins before a waiting stale header save', async () => {
  const { sample } = await setup();
  const transition = (await owner.query(`SELECT transition.id FROM workflow_transitions transition JOIN workflow_runs run
    ON run.organization_id=transition.organization_id AND run.workflow_version_id=transition.workflow_version_id AND run.current_state_id=transition.source_state_id
    WHERE run.organization_id=$1 AND run.id=$2`, [manager.organizationId, sample.workflowRunId])).rows[0];
  let moved; const afterMove = new Promise(resolve => { moved = resolve; });
  let release; const held = new Promise(resolve => { release = resolve; });
  const movement = work(manager, async (client, identity) => {
    const result = await requestWorkflowTransition(client, identity, sample.workflowRunId, { revision: 1, transitionId: transition.id, comment: 'Completed before edit', checklistItemIds: [] });
    moved(); await held; return result;
  });
  let waiting; const afterWait = new Promise(resolve => { waiting = resolve; });
  const errors = [];
  movement.catch(error => { errors.push(error); moved(); });
  await afterMove;
  const saving = work(manager, async (client, identity) => {
    const query = client.query.bind(client);
    client.query = (...args) => { const statement = typeof args[0] === 'string' ? args[0] : args[0].text; if (/from "samples".*for update/i.test(statement)) waiting(); return query(...args); };
    try { return await updateSampleHeader(client, identity, sample.id, { revision: 1, customerAddress: 'Too late' }); }
    finally { client.query = query; }
  });
  saving.catch(error => { errors.push(error); waiting(); });
  await afterWait; release(); await movement;
  await assert.rejects(saving, { code: 'sample_changed' });
  assert.equal(errors.filter(error => error.code !== 'sample_changed').length, 0);
  const current = await row(sample); assert.equal(current.status, 'completed'); assert.equal(current.customer_address, 'Original address');
  assert.equal((await events(sample)).filter(event => event.event_type === 'sample_updated').length, 0);
});

test('an activity insertion failure rolls back the header update and retention change', async () => {
  const { sample } = await setup(); const before = await row(sample); const activity = await events(sample);
  await assert.rejects(work(manager, async (client, identity) => {
    const query = client.query.bind(client);
    client.query = (...args) => { const statement = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/insert into "sample_events"/i.test(statement)) throw new Error('Synthetic activity failure'); return query(...args); };
    try { return await updateSampleHeader(client, identity, sample.id, { revision: 1, receivedAt: '2026-09-13T00:00:00Z', customerAddress: 'Rolled back' }); }
    finally { client.query = query; }
  }), error => /Synthetic activity failure/.test(error.message) || /Synthetic activity failure/.test(error.cause?.message));
  assert.deepEqual(await row(sample), before); assert.deepEqual(await events(sample), activity);
});

test('direct SQL keeps header events limited to managers, actual actors, sample ownership and known event types', async () => {
  const { sample } = await setup();
  const generated = await work(manager, (client, identity) => generateTestRequests(client, identity, sample.id));
  const append = (user, { actor = user.userId, type = 'sample_updated', requestId = null, sampleId = sample.id } = {}) => work(user, client => client.query(`INSERT INTO sample_events
    (organization_id,sample_id,event_type,actor_user_id,description,test_request_id) VALUES ($1,$2,$3,$4,'Synthetic SQL event',$5)`, [user.organizationId, sampleId, type, actor, requestId]));
  for (const user of [allocator, reader, creator]) await assert.rejects(append(user), sqlError('42501'));
  await assert.rejects(append(manager, { actor: reader.userId }), sqlError('42501'));
  await assert.rejects(append(manager, { type: 'invented_event' }), sqlError('23514'));
  await assert.rejects(append(manager, { requestId: generated.items[0].id }), error => error.constraint === 'sample_edit_event_owner');
  await assert.rejects(append(foreign), sqlError('23503'));
});

test('header edits leave generated scientific, final-result, line and report snapshots unchanged', async () => {
  const user = await account(); const flow = await prepareSampleLineFlow(owner, user, { secondLine: false });
  const generated = await work(user, (client, identity) => generateReports(client, identity, flow.sample.id, flow.input));
  const reportId = generated.items[0].id;
  const { metrics: _beforeMetrics, ...document } = await work(user, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  const tables = ['sample_products', 'sample_tests', 'test_requests', 'analytical_specifications', 'datasheets', 'datasheet_submissions', 'sample_line_contexts', 'sample_reports', 'sample_report_tests', 'workflow_runs'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [user.organizationId])).rows.map(value => JSON.stringify(value)).sort()])));
  const before = await snapshot();
  const current = (await owner.query('SELECT revision FROM samples WHERE organization_id=$1 AND id=$2', [user.organizationId, flow.sample.id])).rows[0];
  await work(user, (client, identity) => updateSampleHeader(client, identity, flow.sample.id, { revision: current.revision,
    customerAddress: 'New operational address', customerReference: 'Current reference', receivedByName: 'Current receiver', dueAt: null, totalAmount: '0', currencyCode: 'INR' }));
  assert.deepEqual(await snapshot(), before);
  const { metrics: _afterMetrics, ...after } = await work(user, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.deepEqual(after, document);
});
