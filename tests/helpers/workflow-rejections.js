import { randomUUID } from 'node:crypto';
import { createLaboratoryFixture } from './laboratory.js';
import { withSession } from '../../src/auth/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { registerSample } from '../../src/samples/register.js';
import { requestWorkflowTransition } from '../../src/workflows/requests.js';

export const workflowWork = (user, action, readOnly = false) => withSession(user.token, action, { csrfToken: user.csrfToken, readOnly });

export async function createRejectionWorkflow(manager, responders, { appliesTo = 'sample', mode = 'all', stages, checklistCount = 2, conditions = [] } = {}) {
  return workflowWork(manager, async (client, identity) => {
    const flow = await createWorkflow(client, identity, { code: randomUUID(), name: `Synthetic rejection ${randomUUID()}`, appliesTo });
    const initial = await saveWorkflowState(client, identity, flow.versionId, 1, { code: 'initial', name: 'In Progress', stateType: 'initial', showSampleEdit: true, showAddResult: true });
    const final = await saveWorkflowState(client, identity, flow.versionId, initial.revision, { code: 'complete', name: 'Completed', stateType: 'final', isPositiveTermination: true });
    const edge = await saveWorkflowTransition(client, identity, flow.versionId, final.revision, {
      code: 'complete', name: 'Complete', sourceStateId: initial.id, targetStateId: final.id, approvalMode: mode, requireComment: true,
      approverStages: stages ?? [{ stageNumber: 1, roleIds: responders.map((user) => user.roleId) }],
      conditions,
      checklist: Array.from({ length: checklistCount }, (_, index) => ({ prompt: `Synthetic approval check ${index + 1}`, isRequired: index === 0 })),
    });
    await publishWorkflow(client, identity, flow.versionId, edge.revision, 'Synthetic first rejection verification');
    const definition = await loadWorkflowDefinition(client, identity, flow.versionId);
    return { ...flow, initial, final, transition: definition.transitions[0] };
  });
}

export async function prepareSampleRejection(owner, manager, responders, options = {}) {
  const workflow = await createRejectionWorkflow(manager, responders, options);
  const source = await createLaboratoryFixture(owner, manager, { workflow: false });
  await owner.query("INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default) VALUES($1,$2,$3,'sample',true)", [manager.organizationId, source.category.id, workflow.workflowId]);
  await owner.query(`INSERT INTO organization_laboratory_settings(organization_id,updated_by,sample_workflow_base_id) VALUES($1,$2,$3)
    ON CONFLICT(organization_id) DO UPDATE SET sample_workflow_base_id=$3,revision=organization_laboratory_settings.revision+1,updated_by=$2,updated_at=now()`,
  [manager.organizationId, manager.userId, workflow.workflowId]);
  const sample = await workflowWork(manager, (client, identity) => registerSample(client, identity, source.registration));
  const run = (await owner.query('SELECT * FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2', [manager.organizationId, sample.id])).rows[0];
  const request = await workflowWork(manager, (client, identity) => requestWorkflowTransition(client, identity, run.id, {
    revision: run.revision, transitionId: workflow.transition.id, comment: 'Synthetic request for approval',
    checklistItemIds: workflow.transition.checklist.filter((item) => item.isRequired).map((item) => item.id),
  }));
  const assignments = (await owner.query(`SELECT a.*,s.stage_number FROM approval_assignments a JOIN approval_stages s
    ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id WHERE a.organization_id=$1 AND s.approval_case_id=$2 ORDER BY s.stage_number,a.id`, [manager.organizationId, request.approvalCaseId])).rows;
  return { workflow, source, sample, run, request, assignments };
}
