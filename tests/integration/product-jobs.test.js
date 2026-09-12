import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveProduct } from '../../src/masters/products.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { createTestRequestJobs } from '../../src/test-requests/jobs.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';
import { createTemplate } from '../../src/templates/authoring.js';

const owner = ownerPool();
const work = (user, callback) => withSession(user.token, callback, { csrfToken: user.csrfToken });
after(async () => { await closePool(); await owner.end(); });
async function account(options) {
  const user = await createAccount(owner, options);
  return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
}
async function setTemplate(user, source, templateId) {
  const current = (await owner.query('SELECT revision FROM products WHERE organization_id=$1 AND id=$2', [user.organizationId, source.product.id])).rows[0];
  return work(user, (client, identity) => saveProduct(client, identity, { id: source.product.id, revision: current.revision, requestId: randomUUID(),
    name: source.product.name, key: source.product.code, description: '', abbreviation: null, tagIds: [], jobTemplateId: templateId }));
}
async function configure(user, templateId, automatic = false) {
  const { settings } = await work(user, loadLaboratorySettings);
  return work(user, (client, identity) => saveLaboratorySettings(client, identity, { revision: settings.revision,
    autoCreateJobs: automatic, resultSummaryTemplateId: templateId, jobWorkflowId: null }));
}
async function setup({ lines = 2, automatic = false } = {}) {
  const user = await account({ permissions: ['masters.manage', 'templates.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'settings.manage'] });
  const sources = [];
  for (let index = 0; index < lines; index += 1) {
    const source = await createLaboratoryFixture(owner, user, { repeated: false, generateTestRequests: automatic });
    await setTemplate(user, source, source.template.templateId); sources.push(source);
  }
  const registration = { ...sources[0].registration, products: sources.map((source) => ({ ...source.registration.products[0], sampleCategoryId: source.category.id })) };
  return { user, sources, registration };
}
async function generate(flow) {
  const sample = await work(flow.user, (client, identity) => registerSample(client, identity, flow.registration));
  const generated = await work(flow.user, (client, identity) => generateTestRequests(client, identity, sample.id));
  return { ...flow, sample, requests: generated.items };
}
const create = (flow) => work(flow.user, (client, identity) => createTestRequestJobs(client, identity, {
  requestIds: flow.requests.map((row) => row.id), analystUserId: flow.user.userId }));
const jobs = async (flow) => (await owner.query(`SELECT request.id,request.datasheet_template_id,context.product_id,request.status
  FROM test_requests request JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
  WHERE request.organization_id=$1 AND context.sample_id=$2 AND request.is_job ORDER BY context.product_id`, [flow.user.organizationId, flow.sample.id])).rows;

test('manual jobs use each Product template with no organization settings and keep existing captures after Product edits', async () => {
  const flow = await generate(await setup());
  assert.equal((await owner.query('SELECT 1 FROM organization_laboratory_settings WHERE organization_id=$1', [flow.user.organizationId])).rowCount, 0);
  const created = await create(flow); assert.equal(created.items.length, 2);
  const selected = await jobs(flow);
  for (const job of selected) assert.equal(job.datasheet_template_id, flow.sources.find((source) => source.product.id === job.product_id).template.templateId);
  const source = flow.sources[0]; const job = selected.find((row) => row.product_id === source.product.id); const prior = created.items.find((row) => row.id === job.id);
  await setTemplate(flow.user, source, flow.sources[1].template.templateId);
  const reassigned = await work(flow.user, (client, identity) => allocateTestRequest(client, identity, job.id,
    { revision: prior.revision, assignmentType: 'analyst', assignedUserId: flow.user.userId }));
  assert.equal(reassigned.datasheetId, prior.datasheetId);
  assert.equal((await jobs(flow)).find((row) => row.id === job.id).datasheet_template_id, source.template.templateId);
});

test('organization summary takes precedence and an unavailable configured organization template cannot fall through to a Product', async () => {
  const flow = await generate(await setup()); await configure(flow.user, flow.sources[0].template.templateId);
  await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [flow.user.organizationId, flow.sources[0].template.templateId]);
  await assert.rejects(create(flow), { code: 'job_template_not_configured' }); assert.deepEqual(await jobs(flow), []);
  await owner.query('UPDATE templates SET active=true WHERE organization_id=$1 AND id=$2', [flow.user.organizationId, flow.sources[0].template.templateId]);
  await create(flow); assert.ok((await jobs(flow)).every((row) => row.datasheet_template_id === flow.sources[0].template.templateId));
});

test('missing, inactive or wrong-kind Product templates cannot leave a manual mixed-product selection partially grouped', async () => {
  const flow = await generate(await setup()); const source = flow.sources[1];
  const report = await work(flow.user, (client, identity) => createTemplate(client, identity, { name: 'Product report metadata', kind: 'report' }));
  for (const state of ['missing', 'wrong_kind', 'inactive']) {
    await setTemplate(flow.user, source, state === 'missing' ? null : state === 'wrong_kind' ? report.templateId : source.template.templateId);
    if (state === 'inactive') await owner.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [flow.user.organizationId, source.template.templateId]);
    await assert.rejects(create(flow), { code: 'job_template_not_configured' }); assert.deepEqual(await jobs(flow), []);
    const children = (await owner.query('SELECT parent_test_request_id,status FROM test_requests WHERE organization_id=$1 AND id=ANY($2::uuid[])', [flow.user.organizationId, flow.requests.map((row) => row.id)])).rows;
    assert.ok(children.every((row) => row.parent_test_request_id === null && row.status === 'created'));
    assert.equal((await owner.query("SELECT 1 FROM sample_events WHERE organization_id=$1 AND sample_id=$2 AND event_type='test_request_job_created'", [flow.user.organizationId, flow.sample.id])).rowCount, 0);
  }
});

test('registration-only automatic generation uses Product fallback and keeps unavailable groups unassigned', async () => {
  const flow = await setup({ automatic: true }); const creator = await account({ organizationId: flow.user.organizationId, permissions: ['samples.create'] });
  await configure(flow.user, null, true); await setTemplate(flow.user, flow.sources[1], null);
  flow.sample = await work(creator, (client, identity) => registerSample(client, identity, flow.registration));
  const selected = await jobs(flow); assert.equal(selected.length, 1); assert.equal(selected[0].datasheet_template_id, flow.sources[0].template.templateId);
  assert.equal(selected[0].status, 'created');
  const children = (await owner.query(`SELECT request.parent_test_request_id,request.status,context.product_id,sheet.id AS datasheet_id
    FROM test_requests request JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
    LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id
    WHERE request.organization_id=$1 AND context.sample_id=$2 AND NOT request.is_job`, [flow.user.organizationId, flow.sample.id])).rows;
  const available = children.find((row) => row.product_id === flow.sources[0].product.id); const missing = children.find((row) => row.product_id === flow.sources[1].product.id);
  assert.equal(available.parent_test_request_id, selected[0].id); assert.equal(available.status, 'allocated'); assert.ok(available.datasheet_id);
  assert.equal(missing.parent_test_request_id, null); assert.equal(missing.status, 'created'); assert.equal(missing.datasheet_id, null);
  const replay = await work(flow.user, (client, identity) => generateTestRequests(client, identity, flow.sample.id));
  assert.deepEqual(replay, { items: [], jobs: [] });
});

test('the Product job resolver enforces actual automatic generation, tenant/sample scope and ordered distinct bounds', async () => {
  const flow = await generate(await setup({ lines: 1 })); const foreign = await account({ permissions: ['test_requests.allocate'] });
  const reader = await account({ organizationId: flow.user.organizationId, permissions: ['masters.read'] });
  const line = (await owner.query('SELECT id FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [flow.user.organizationId, flow.sample.id])).rows[0].id;
  const resolve = (user, ids, automatic, sampleId = flow.sample.id) => work(user, (client) => client.query('SELECT * FROM laboratory_product_job_templates($1,$2::uuid[],$3)', [sampleId, ids, automatic]));
  await assert.rejects(resolve(foreign, [line], false), { code: '23514' });
  await assert.rejects(resolve(reader, [line], false), { code: '42501' });
  for (const user of [flow.user, foreign, reader]) await assert.rejects(resolve(user, [line], true), { code: '42501' });
  for (const ids of [[], [line, line], [null], Array.from({ length: 501 }, () => randomUUID()), [randomUUID()]]) await assert.rejects(resolve(flow.user, ids, false), { code: '23514' });
  assert.equal((await owner.query("SELECT has_function_privilege('sampleify_report_worker','laboratory_product_job_templates(uuid,uuid[],boolean)','EXECUTE') AS allowed")).rows[0].allowed, false);
});

test('concurrent Product and organization edits wait for job selection and cannot retarget the created capture', async () => {
  const flow = await generate(await setup({ lines: 1 })); await configure(flow.user, null);
  const replacement = await createLaboratoryFixture(owner, flow.user, { repeated: false });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let selected; let selectionFailed; const ready = new Promise((resolve, reject) => { selected = resolve; selectionFailed = reject; });
  const creating = work(flow.user, async (client, identity) => {
    const query = client.query;
    client.query = async (...args) => {
      const result = await query.apply(client, args);
      if (typeof args[0] === 'string' && args[0].includes('laboratory_product_job_templates')) { selected(); await gate; }
      return result;
    };
    try { return await createTestRequestJobs(client, identity, { requestIds: flow.requests.map((row) => row.id), analystUserId: flow.user.userId }); }
    finally { client.query = query; }
  });
  creating.catch(selectionFailed); await ready;
  const source = flow.sources[0]; let productPid; let settingsPid;
  const productChange = work(flow.user, async (client, identity) => {
    productPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return saveProduct(client, identity, { id: source.product.id, revision: 2, requestId: randomUUID(), name: source.product.name, key: source.product.code,
      description: '', abbreviation: null, tagIds: [], jobTemplateId: replacement.template.templateId });
  });
  const settingsChange = work(flow.user, async (client, identity) => {
    settingsPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return saveLaboratorySettings(client, identity, { revision: 1, autoCreateJobs: false, resultSummaryTemplateId: replacement.template.templateId, jobWorkflowId: null });
  });
  // Observe real PostgreSQL blockers rather than assuming timing proves a lock.
  const changes = Promise.allSettled([productChange, settingsChange]);
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (productPid && settingsPid) blocked = (await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AND cardinality(pg_blocking_pids($2))>0 AS blocked', [productPid, settingsPid])).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'Both metadata writers must wait for the active job transaction.');
  } finally { release(); }
  const created = await creating; const edited = await changes;
  assert.ok(edited.every((result) => result.status === 'fulfilled')); assert.equal(created.items.length, 1);
  assert.equal((await jobs(flow))[0].datasheet_template_id, source.template.templateId);
  const captured = (await owner.query(`SELECT version.template_id FROM datasheets sheet JOIN template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    JOIN template_versions version ON version.organization_id=capture.organization_id AND version.id=capture.version_id WHERE sheet.organization_id=$1 AND sheet.id=$2`,
  [flow.user.organizationId, created.items[0].datasheetId])).rows[0];
  assert.equal(captured.template_id, source.template.templateId);
});

test('a first organization-settings insertion after Product resolution cannot commit a job with a conflicting template', async () => {
  const flow = await generate(await setup({ lines: 1 })); const replacement = await createLaboratoryFixture(owner, flow.user, { repeated: false });
  await assert.rejects(work(flow.user, async (client, identity) => {
    const query = client.query; let changed = false;
    client.query = async (...args) => {
      const result = await query.apply(client, args);
      if (!changed && typeof args[0] === 'string' && args[0].includes('laboratory_product_job_templates')) {
        changed = true; await configure(flow.user, replacement.template.templateId);
      }
      return result;
    };
    try { return await createTestRequestJobs(client, identity, { requestIds: flow.requests.map((row) => row.id), analystUserId: flow.user.userId }); }
    finally { client.query = query; }
  }), { code: '23514' });
  assert.deepEqual(await jobs(flow), []);
  assert.ok((await owner.query('SELECT parent_test_request_id,status FROM test_requests WHERE organization_id=$1 AND id=ANY($2::uuid[])',
    [flow.user.organizationId, flow.requests.map((row) => row.id)])).rows.every((row) => row.parent_test_request_id === null && row.status === 'created'));
  assert.equal((await create(flow)).items.length, 1);
  assert.equal((await jobs(flow))[0].datasheet_template_id, replacement.template.templateId);
});
