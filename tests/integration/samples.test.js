import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, database } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { analyticalRecords } from '../helpers/templates.js';
import { createTemplate, copyDefinition, freezeTemplate } from '../../src/templates/authoring.js';
import { loadCapture } from '../../src/templates/loader.js';
import { setCaptureContext } from '../../src/templates/access.js';
import { addImageWidget } from '../helpers/template-image-fixture.js';
import { animatedPng } from '../helpers/template-images.js';

const owner = ownerPool();
let author; let registrar; let allocator; let reader; let manager; let foreign;
before(async () => {
  author = await createAccount(owner, { permissions: ['templates.manage', 'masters.manage', 'workflows.manage', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'] });
  Object.assign(author, await signIn({ identifier: author.username, password: author.password }));
  const users = [];
  for (const permissions of [['samples.create'], ['test_requests.allocate'], ['samples.read'], ['samples.manage']]) {
    const account = await createAccount(owner, { organizationId: author.organizationId, permissions });
    users.push({ ...account, ...await signIn({ identifier: account.username, password: account.password }) });
  }
  [registrar, allocator, reader, manager] = users;
  const account = await createAccount(owner, { permissions: ['samples.create', 'test_requests.allocate'] });
  foreign = { ...account, ...await signIn({ identifier: account.username, password: account.password }) };
});
after(async () => { await closePool(); await owner.end(); });
const work = (session, action) => withSession(session.token, action, { csrfToken: session.csrfToken });
const fixture = (options) => createLaboratoryFixture(owner, author, options);
const register = (source, session = registrar) => work(session, (client, identity) => registerSample(client, identity, source.registration));
const generate = (sampleId, input = {}, session = allocator) => work(session, (client, identity) => generateTestRequests(client, identity, sampleId, input));

test('a registrar without master editing creates typed sample/products/tests, retention and a pinned workflow atomically', async () => {
  const source = await fixture();
  const created = await register(source);
  assert.match(created.sampleNumber, /^SMP-2026-\d{6}$/);
  assert.equal(created.sampleTestIds.length, 1);
  assert.equal(created.testRequests.length, 0);
  const sample = (await owner.query('SELECT *, retention_due_on::text AS retention_date FROM samples WHERE organization_id=$1 AND id=$2', [author.organizationId, created.id])).rows[0];
  assert.equal(sample.registered_by, registrar.userId);
  assert.equal(sample.category_name, source.category.name);
  assert.equal(sample.retention_date, '2026-10-12');
  const products = await owner.query('SELECT * FROM sample_products WHERE organization_id=$1 AND sample_id=$2', [author.organizationId, created.id]);
  assert.equal(products.rowCount, 1);
  assert.equal(products.rows[0].quantity, '1.25');
  assert.equal(products.rows[0].unit_symbol, 'mg/L');
  const selected = (await owner.query('SELECT * FROM sample_tests WHERE organization_id=$1 AND id=$2', [author.organizationId, created.sampleTestIds[0]])).rows[0];
  assert.equal(selected.rate, '0');
  assert.equal(selected.is_retest, false);
  const history = (await owner.query('SELECT * FROM workflow_run_history WHERE organization_id=$1 AND workflow_run_id=$2', [author.organizationId, created.workflowRunId])).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].actor_user_id, registrar.userId);
  assert.equal(history[0].to_state_id, source.workflowRecords[0].state.id);
  const denied = await work(registrar, (client) => client.query('UPDATE methods_of_analysis SET revision=revision+1, name=$2 WHERE id=$1', [source.method.id, 'Denied']));
  assert.equal(denied.rowCount, 0);
});

test('missing workflow and invalid references roll back all dependent writes and the allocated number', async () => {
  const source = await fixture({ workflow: false });
  const before = (await owner.query("SELECT (SELECT count(*) FROM samples WHERE organization_id=$1) AS sample_count, next_value FROM number_sequences WHERE organization_id=$1 AND sequence_key='sample' AND period_key='2026'", [author.organizationId])).rows[0];
  await assert.rejects(register(source), { code: 'workflow_not_configured' });
  const after = (await owner.query("SELECT (SELECT count(*) FROM samples WHERE organization_id=$1) AS sample_count, next_value FROM number_sequences WHERE organization_id=$1 AND sequence_key='sample' AND period_key='2026'", [author.organizationId])).rows[0];
  assert.deepEqual(after, before);
  const valid = await fixture();
  await assert.rejects(register(valid, foreign), { code: 'invalid_sample_reference' });
  await assert.rejects(register(valid, reader), { status: 403 });
  valid.registration.products[0].tests.push({ ...valid.registration.products[0].tests[0] });
  await assert.rejects(register(valid), { code: 'invalid_sample' });
  await assert.rejects(work(registrar, (client) => client.query('SELECT laboratory_lock_references($1, $2::uuid[])', ['users', [author.userId]])), { code: '23514' });
});

test('concurrent generation creates one request and immutable scientific interpretation; explicit duplicate selection conflicts', async () => {
  const source = await fixture();
  const sample = await register(source);
  const results = await Promise.all([generate(sample.id), generate(sample.id)]);
  assert.equal(results.flatMap((result) => result.items).length, 1);
  const requestId = results.flatMap((result) => result.items)[0].id;
  const snapshot = (await owner.query(`SELECT specification.* FROM analytical_specifications specification JOIN test_requests request
    ON request.organization_id=specification.organization_id AND request.specification_id=specification.id WHERE request.organization_id=$1 AND request.id=$2`, [author.organizationId, requestId])).rows[0];
  assert.equal(snapshot.method_name, source.method.name);
  assert.equal(snapshot.recorded_by, allocator.userId);
  assert.equal(snapshot.unit_symbol, 'mg/L');
  assert.equal(snapshot.cutoff_value, '10');
  await owner.query('UPDATE methods_of_analysis SET revision=revision+1, name=$3, decimal_scale=4 WHERE organization_id=$1 AND id=$2', [author.organizationId, source.method.id, 'New method name']);
  await owner.query('UPDATE decision_rules SET revision=revision+1, cutoff_value=20 WHERE organization_id=$1 AND id=$2', [author.organizationId, source.rule.id]);
  const prior = (await owner.query('SELECT * FROM analytical_specifications WHERE organization_id=$1 AND id=$2', [author.organizationId, snapshot.id])).rows[0];
  assert.equal(prior.method_name, source.method.name);
  assert.equal(prior.decimal_scale, 2);
  assert.equal(prior.cutoff_value, '10');
  await assert.rejects(owner.query('UPDATE analytical_specifications SET cutoff_value=99 WHERE organization_id=$1 AND id=$2', [author.organizationId, snapshot.id]), { code: '55000' });
  await assert.rejects(owner.query("INSERT INTO analytical_specification_limits(organization_id, specification_id, id, lower_limit, lower_inclusive, upper_inclusive, outcome, display_order) VALUES($1,$2,$3,0,true,true,'Late criterion',1)", [author.organizationId, snapshot.id, randomUUID()]), { code: '55000' });
  await assert.rejects(generate(sample.id, { sampleTestIds: sample.sampleTestIds }), { code: 'sample_test_not_available' });
  await assert.rejects(generate(sample.id, {}, foreign), { status: 404 });
  await assert.rejects(generate(sample.id, {}, reader), { status: 403 });
});

test('configured workflow roles override fallback permissions, while source automatic generation and amendment rules remain distinct', async () => {
  const blocked = await fixture({ capabilityRoleId: author.roleId });
  const sample = await register(blocked);
  await assert.rejects(generate(sample.id), { code: 'workflow_action_denied' });
  const automatic = await fixture({ generateTestRequests: true, capabilityRoleId: author.roleId });
  const created = await register(automatic);
  assert.equal(created.testRequests.length, 1);
  const amendment = await fixture({ generateTestRequests: true });
  amendment.registration.sampleType = 'amendment';
  assert.equal((await register(amendment)).testRequests.length, 0);
  await assert.rejects(owner.query('UPDATE workflow_states SET name=$3 WHERE organization_id=$1 AND id=$2', [author.organizationId, automatic.workflowRecords[0].state.id, 'Changed history']), { code: '55000' });
  await assert.rejects(owner.query('DELETE FROM workflow_state_capability_roles WHERE organization_id=$1 AND workflow_state_id=$2', [author.organizationId, automatic.workflowRecords[0].state.id]), { code: '55000' });
});

test('creation permission does not confer management, manual generation, existing-sample access or a replayable registration context', async () => {
  const source = await fixture();
  await assert.rejects(register(source, manager), { status: 403 });
  const created = await register(source);
  await assert.rejects(generate(created.id, {}, registrar), { status: 403 });
  await assert.rejects(work(registrar, (client, identity) => generateTestRequests(client, identity, created.id, {}, { automatic: true })), { code: 'registration_required' });
  await work(registrar, async (client, identity) => {
    await client.query("SELECT set_config('app.registration_sample_id', $1, true)", [created.id]);
    assert.equal((await client.query('SELECT laboratory_registering_sample() AS id')).rows[0].id, null);
    assert.equal((await client.query('SELECT id FROM samples WHERE organization_id=$1 AND id=$2', [identity.organization_id, created.id])).rowCount, 0);
    assert.equal((await client.query("UPDATE samples SET description='Denied', revision=revision+1 WHERE organization_id=$1 AND id=$2", [identity.organization_id, created.id])).rowCount, 0);
    assert.equal((await client.query("UPDATE sample_tests SET status='cancelled' WHERE organization_id=$1 AND id=$2", [identity.organization_id, created.sampleTestIds[0]])).rowCount, 0);
  });
  await work(registrar, async (client, identity) => {
    const result = await registerSample(client, identity, source.registration);
    assert.equal((await client.query('SELECT laboratory_registering_sample() AS id')).rows[0].id, null);
    await assert.rejects(generateTestRequests(client, identity, result.id, {}, { automatic: true }), { code: 'registration_required' });
  });
  // An allocator's broader selected-test policy must not bypass the insertion
  // trigger when registration context is absent (including SQL NULL semantics).
  const selected = (await owner.query('SELECT * FROM sample_tests WHERE organization_id=$1 AND id=$2', [author.organizationId, created.sampleTestIds[0]])).rows[0];
  await assert.rejects(work(allocator, (client) => client.query(`INSERT INTO sample_tests
    (organization_id,id,sample_product_id,test_parameter_id,method_id,requested_quantity,display_order,is_retest)
    VALUES ($1,$2,$3,$4,$5,1,1,true)`, [author.organizationId, randomUUID(), selected.sample_product_id, source.parameter.id, source.method.id])), { code: '42501' });
});

test('a create-only registrar initializes the frozen sample capture but cannot later edit or read it without runtime permissions', async () => {
  const source = await fixture({ generateTestRequests: true });
  const template = await work(author, async (client, identity) => {
    const created = await createTemplate(client, identity, { name: 'Synthetic sample registration template', kind: 'sample' });
    const records = analyticalRecords({ rowCount: 1, repeated: true });
    await copyDefinition(database(client), records, identity.organization_id, created.versionId);
    const image = { requestId: randomUUID(), originalName: 'Synthetic registration image.png', mediaType: 'image/png', content: await animatedPng() };
    const withImage = await addImageWidget(client, identity, created, image, { rowId: records.rows[0].id });
    await freezeTemplate(client, identity, created.versionId, withImage.model.version.revision);
    await client.query(`INSERT INTO sample_category_templates(organization_id,sample_category_id,template_id,purpose,is_default)
      VALUES($1,$2,$3,'sample',true)`, [identity.organization_id, source.category.id, created.templateId]);
    return { ...created, imageId: image.requestId };
  });
  const sample = await register(source);
  assert.ok(sample.templateInstanceId); assert.equal(sample.testRequests.length, 1);
  const capture = await work(reader, (client, identity) => loadCapture(client, identity.organization_id, sample.templateInstanceId));
  assert.equal(capture.instance.version_id, template.versionId);
  assert.equal(capture.instance.created_by, registrar.userId);
  assert.equal(capture.occurrences.length, 3);
  assert.equal(capture.values.filter((value) => value.origin === 'calculated').length, 2);
  assert.equal(capture.values.filter((value) => value.origin === 'default' && value.imageId === template.imageId).length, 2);
  await assert.rejects(work(registrar, (client, identity) => loadCapture(client, identity.organization_id, sample.templateInstanceId)), { code: 'capture_not_found' });
  await work(registrar, async (client) => {
    await setCaptureContext(client, sample.templateInstanceId);
    const changed = await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [author.organizationId, sample.templateInstanceId]);
    assert.equal(changed.rowCount, 0);
  });
});
