import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';

const capabilities = { view: 'view', edit: 'edit', allocate: 'allocate', addResult: 'execute', printCoa: 'download_report', reissue: 'download_report' };
const flags = { edit: 'show_sample_edit', addResult: 'show_add_result', reissue: 'show_sample_reissue' };
const fallbackPermissions = {
  view: ['samples.read', 'samples.manage'], edit: ['samples.manage'], allocate: ['test_requests.allocate', 'samples.manage'],
  addResult: ['datasheets.execute', 'samples.manage'], printCoa: ['samples.manage'], reissue: ['samples.manage'], workOnTestRequest: ['datasheets.execute', 'samples.manage'],
};

export function workflowAllowedActions(identity, state, configured = []) {
  const permissionAllows = (action) => fallbackPermissions[action].some((permission) => identity.permission_codes?.includes(permission));
  const byCapability = new Map(configured.map((row) => [row.capability, row.is_allowed]));
  const allowedActions = {}; const permissionFallbackActions = {};
  for (const [action, capability] of Object.entries(capabilities)) {
    const present = Boolean(state) && byCapability.has(capability);
    allowedActions[action] = present ? (!flags[action] || Boolean(state[flags[action]])) && byCapability.get(capability) === true : permissionAllows(action);
    permissionFallbackActions[action] = !present;
  }
  allowedActions.workOnTestRequest = state && byCapability.size ? Boolean(state.can_work_on_test_request) : permissionAllows('workOnTestRequest');
  permissionFallbackActions.workOnTestRequest = !state || byCapability.size === 0;
  return { allowedActions, permissionFallbackActions, usesPermissionFallback: Object.values(permissionFallbackActions).some(Boolean) };
}

export async function workflowStateAccess(client, identity, owner) {
  uuid(owner.id, 'Workflow owner');
  if (!['sample', 'test_request', 'document'].includes(owner.type)) throw new HttpError(400, 'invalid_workflow_owner', 'Select a valid workflow owner.');
  const result = await client.query(`SELECT state.*, run.id AS workflow_run_id FROM workflow_runs run JOIN workflow_states state
    ON state.organization_id = run.organization_id AND state.workflow_version_id = run.workflow_version_id AND state.id = run.current_state_id
    WHERE run.organization_id = $1 AND (($2 = 'sample' AND run.sample_id = $3) OR ($2 = 'test_request' AND run.test_request_id = $3) OR ($2 = 'document' AND run.document_id = $3))`,
  [identity.organization_id, owner.type, owner.id]);
  const state = result.rows[0] ?? null;
  let configured = [];
  if (state) {
    const result = await client.query(`SELECT capability.capability, bool_or(assignment.user_id IS NOT NULL) AS is_allowed
      FROM workflow_state_capability_roles capability LEFT JOIN membership_roles assignment
      ON assignment.organization_id = capability.organization_id AND assignment.role_id = capability.role_id AND assignment.user_id = $3
      WHERE capability.organization_id = $1 AND capability.workflow_state_id = $2 GROUP BY capability.capability`,
    [identity.organization_id, state.id, identity.user_id]);
    configured = result.rows;
  }
  return { state, ...workflowAllowedActions(identity, state, configured) };
}

export async function requireWorkflowAction(client, identity, owner, action) {
  const access = await workflowStateAccess(client, identity, owner);
  if (!access.allowedActions[action]) throw new HttpError(403, 'workflow_action_denied', `The current workflow state does not allow ${action}.`);
  return access;
}
