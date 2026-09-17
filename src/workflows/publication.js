// Draft graphs may be incomplete. Activation keeps the same graph and approval
// requirements enforced by the native publication guards.
export function workflowPublicationProblem({ states, transitions }) {
  if (states.filter(state => state.stateType === 'initial').length !== 1
    || states.filter(state => state.stateType === 'final').length !== 1) {
    return 'Add exactly one initial and final state, and connect every initial or normal state.';
  }
  const outgoing = new Set(transitions.map(transition => transition.sourceStateId));
  if (states.some(state => ['initial', 'normal'].includes(state.stateType) && !outgoing.has(state.id))) {
    return 'Add exactly one initial and final state, and connect every initial or normal state.';
  }
  if (transitions.some(transition => {
    const stages = transition.approverStages ?? [];
    return transition.approvalMode === 'none' ? stages.length > 0
      : !stages.length || stages.some(stage => !stage.roleIds.length || transition.approvalMode !== 'sequential' && stage.stageNumber !== 1);
  })) return 'Configure approver roles and stages for every approval connection.';
  return null;
}
