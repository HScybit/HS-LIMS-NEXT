import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { sampleTestRequests } from '../../src/test-requests/listing.js';

const owner = ownerPool();
const work = (actor, callback) => withSession(actor.token, callback, { csrfToken: actor.csrfToken });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read', 'test_requests.allocate'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function subject(actor, mode) {
  const fixture = await createLaboratoryFixture(owner, actor, { repeated: false });
  const sample = await work(actor, (client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work(actor, (client, identity) => generateTestRequests(client, identity, sample.id));
  let requestId = generated.items[0].id;
  if (mode !== true) {
    requestId = randomUUID();
    await owner.query(`INSERT INTO test_requests(organization_id,id,request_number,sample_test_id,specification_id,attempt_number,datasheet_template_id,created_by,using_dynamic_workflow)
      SELECT organization_id,$3,request_number||'-historical',sample_test_id,specification_id,2,datasheet_template_id,created_by,$4
      FROM test_requests WHERE organization_id=$1 AND id=$2`, [actor.organizationId, generated.items[0].id, requestId, mode]);
  }
  return { fixture, sample, requestId };
}
after(async () => { await closePool(); await owner.end(); });

for (const mode of [true, false, null]) for (const categoryAvailable of [true, false]) {
  test(`listing honors request mode ${mode} with category availability ${categoryAvailable}`, async () => {
    const actor = await account(); const { fixture, sample, requestId } = await subject(actor, mode);
    if (!categoryAvailable) await owner.query("DELETE FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 AND applies_to='test_request'", [actor.organizationId, fixture.category.id]);
    const result = await work(actor, (client, identity) => sampleTestRequests(client, identity, sample.id));
    const row = result.rows.find(item => item.id === requestId);
    assert.ok(row);
    assert.equal(row.usesDynamicWorkflow, mode ?? categoryAvailable);
    assert.equal(row.canJoinJob, true);
    assert.equal(result.canCreateJobs, true);
  });
}

test('historical null listing still requires a published category workflow', async () => {
  const actor = await account(); const { fixture, sample, requestId } = await subject(actor, null);
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND id=$2 AND status='published'", [actor.organizationId, fixture.workflowRecords[1].version.id]);
  const result = await work(actor, (client, identity) => sampleTestRequests(client, identity, sample.id));
  assert.equal(result.rows.find(row => row.id === requestId).usesDynamicWorkflow, false);
  assert.equal(result.rows.find(row => row.id !== requestId).usesDynamicWorkflow, true);
});

test('workflow mode listing keeps read-only access and tenant restrictions', async () => {
  const manager = await account(); const { fixture, sample, requestId } = await subject(manager, true);
  await owner.query("DELETE FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 AND applies_to='test_request'", [manager.organizationId, fixture.category.id]);
  const reader = await account({ organizationId: manager.organizationId, permissions: ['samples.read'] });
  const result = await work(reader, (client, identity) => sampleTestRequests(client, identity, sample.id));
  assert.equal(result.rows.find(row => row.id === requestId).usesDynamicWorkflow, true);
  assert.equal(result.canCreateJobs, false); assert.deepEqual(result.users, []);
  assert.ok(result.rows.every(row => !row.canJoinJob && !row.canAllocate));
  const foreign = await account({ permissions: ['samples.read'] });
  await assert.rejects(work(foreign, (client, identity) => sampleTestRequests(client, identity, sample.id)), { code: 'sample_not_found' });
  const denied = await account({ organizationId: manager.organizationId, permissions: [] });
  await assert.rejects(work(denied, (client, identity) => sampleTestRequests(client, identity, sample.id)), { code: 'forbidden' });
});
