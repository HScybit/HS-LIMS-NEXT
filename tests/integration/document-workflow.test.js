import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { requestWorkflowTransition, approveWorkflowAssignment, rejectWorkflowAssignment } from '../../src/workflows/requests.js';
import { createDocumentCategory, updateDocumentCategory, createDocument, uploadDocumentFile, loadDocumentWorkflow } from '../../src/documents/service.js';

const owner = ownerPool(); let admin; let approver; let reader;
const work = (action, user = admin) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  admin = await account({ permissions: ['documents.manage', 'workflows.manage'] });
  approver = await account({ organizationId: admin.organizationId, permissions: ['approvals.respond'] });
  reader = await account({ organizationId: admin.organizationId, permissions: ['documents.read'] });
});
after(async () => { await closePool(); await owner.end(); });

async function documentWorkflow({ mode = 'all', checklistCount = 0 } = {}) {
  const flow = await work((client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic document workflow ${randomUUID()}`, appliesTo: 'document' }));
  const initial = await work((client, identity) => saveWorkflowState(client, identity, flow.versionId, 1, { code: 'draft', name: 'Draft', stateType: 'initial', showSampleEdit: false, showAddResult: false }));
  const final = await work((client, identity) => saveWorkflowState(client, identity, flow.versionId, initial.revision, { code: 'approved', name: 'Approved', stateType: 'final', isPositiveTermination: true }));
  const edge = await work((client, identity) => saveWorkflowTransition(client, identity, flow.versionId, final.revision, {
    code: 'approve', name: 'Approve', sourceStateId: initial.id, targetStateId: final.id, approvalMode: mode, requireComment: false,
    approverStages: [{ stageNumber: 1, roleIds: [approver.roleId] }],
    checklist: Array.from({ length: checklistCount }, (_, index) => ({ prompt: `Synthetic check ${index + 1}`, isRequired: true })),
  }));
  await work((client, identity) => publishWorkflow(client, identity, flow.versionId, edge.revision, 'Synthetic document workflow'));
  const definition = await work((client, identity) => loadWorkflowDefinition(client, identity, flow.versionId));
  return { ...flow, initial, final, transition: definition.transitions[0] };
}

async function categoryWithWorkflow(workflowId) {
  return work((client, identity) => createDocumentCategory(client, identity, { name: `SOP ${randomUUID()}`, expiryApplicable: false, accessUserIds: [admin.userId, approver.userId, reader.userId], workflowId }));
}
async function uploadedFile(actor = admin) {
  return work((client, identity) => uploadDocumentFile(client, identity, { requestId: randomUUID(), originalName: 'sop.pdf', mediaType: 'application/pdf', content: Buffer.from('synthetic document bytes') }), actor);
}

test('a document category can only reference an active document-type workflow', async () => {
  const sampleFlow = await work((client, identity) => createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic sample workflow ${randomUUID()}`, appliesTo: 'sample' }));
  await assert.rejects(categoryWithWorkflow(sampleFlow.workflowId), { code: 'invalid_document_workflow' });
  const category = await categoryWithWorkflow(null);
  assert.equal(category.workflowId, null);
});

test('creating a document in a workflow-linked category starts a run, and each new version gets its own fresh run', async () => {
  const flow = await documentWorkflow();
  const category = await categoryWithWorkflow(flow.workflowId);
  const file = await uploadedFile();
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-100', documentCategoryId: category.id, fileId: file.id }));
  assert.ok(document.workflowRunId);
  const resolved = await work((client, identity) => loadDocumentWorkflow(client, identity, document.id), reader);
  assert.equal(resolved.workflowRunId, document.workflowRunId);
  const run = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, document.workflowRunId])).rows[0];
  assert.equal(run.document_id, document.id);
  assert.equal(run.sample_id, null); assert.equal(run.test_request_id, null);

  const nextFile = await uploadedFile();
  const version2 = await work((client, identity) => createDocument(client, identity,
    { name: 'SOP-100', documentCategoryId: category.id, fileId: nextFile.id, parentDocumentId: document.id, versionLabel: 'v2' }));
  assert.ok(version2.workflowRunId);
  assert.notEqual(version2.workflowRunId, document.workflowRunId);
  const originalRunAfter = (await owner.query('SELECT status FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, document.workflowRunId])).rows[0];
  assert.notEqual(originalRunAfter, undefined);
});

test('a document in a category without a workflow has no run', async () => {
  const category = await categoryWithWorkflow(null);
  const file = await uploadedFile();
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-101', documentCategoryId: category.id, fileId: file.id }));
  assert.equal(document.workflowRunId, null);
  const resolved = await work((client, identity) => loadDocumentWorkflow(client, identity, document.id));
  assert.equal(resolved.workflowRunId, null);
});

test('a document workflow transition can be requested and approved through the shared generic endpoints', async () => {
  const flow = await documentWorkflow({ checklistCount: 1 });
  const category = await categoryWithWorkflow(flow.workflowId);
  const file = await uploadedFile();
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-102', documentCategoryId: category.id, fileId: file.id }));
  const run = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, document.workflowRunId])).rows[0];

  const request = await work((client, identity) => requestWorkflowTransition(client, identity, run.id, {
    revision: run.revision, transitionId: flow.transition.id,
    checklistItemIds: flow.transition.checklist.map((item) => item.id),
  }));
  assert.ok(request.approvalCaseId);
  const assignment = (await owner.query(`SELECT a.* FROM approval_assignments a JOIN approval_stages s
    ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id WHERE a.organization_id=$1 AND s.approval_case_id=$2`, [admin.organizationId, request.approvalCaseId])).rows[0];

  const approved = await work((client, identity) => approveWorkflowAssignment(client, identity, assignment.id, { comment: 'Looks correct', checklistItemIds: flow.transition.checklist.map((item) => item.id) }), approver);
  assert.equal(approved.status, 'completed');
  const runAfter = (await owner.query('SELECT current_state_id, status FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, run.id])).rows[0];
  assert.equal(runAfter.current_state_id, flow.final.id);
});

test('a document workflow transition can be rejected, and rejection is possible again after conditions still hold', async () => {
  const flow = await documentWorkflow();
  const category = await categoryWithWorkflow(flow.workflowId);
  const file = await uploadedFile();
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-103', documentCategoryId: category.id, fileId: file.id }));
  const run = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, document.workflowRunId])).rows[0];

  const request = await work((client, identity) => requestWorkflowTransition(client, identity, run.id, { revision: run.revision, transitionId: flow.transition.id }));
  const assignment = (await owner.query(`SELECT a.* FROM approval_assignments a JOIN approval_stages s
    ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id WHERE a.organization_id=$1 AND s.approval_case_id=$2`, [admin.organizationId, request.approvalCaseId])).rows[0];

  const rejected = await work((client, identity) => rejectWorkflowAssignment(client, identity, assignment.id, { comment: 'Not ready yet' }), approver);
  assert.equal(rejected.status, 'rejected');
  const runAfter = (await owner.query('SELECT current_state_id, status, revision FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, run.id])).rows[0];
  assert.equal(runAfter.current_state_id, flow.initial.id);

  const secondRequest = await work((client, identity) => requestWorkflowTransition(client, identity, run.id, { revision: runAfter.revision, transitionId: flow.transition.id }));
  assert.ok(secondRequest.approvalCaseId);
});

test('a reader without workflow or document-manage permission cannot request a document workflow transition', async () => {
  const flow = await documentWorkflow();
  const category = await categoryWithWorkflow(flow.workflowId);
  const file = await uploadedFile();
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-104', documentCategoryId: category.id, fileId: file.id }));
  const run = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND id=$2', [admin.organizationId, document.workflowRunId])).rows[0];
  await assert.rejects(work((client, identity) => requestWorkflowTransition(client, identity, run.id, { revision: run.revision, transitionId: flow.transition.id }), reader), { code: 'forbidden' });
});
