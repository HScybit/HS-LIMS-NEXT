/**
 * Workflow masters, ported from PERN's `workflowV3Catalog.js`.
 *
 * Role codes are the shared catalog's role refs with underscores replaced, so
 * `qa_approver` is named here as `qa-approver`. Every transition asks any one
 * of its approver roles (plus the organization's administrators) for approval
 * and requires a comment, exactly as PERN seeds them.
 */
export const workflowDefinitions = Object.freeze([
  {
    code: 'STANDARD-SAMPLE-LIFECYCLE',
    name: 'Sample Lifecycle',
    description: 'Receipt, analysis and release of a laboratory sample.',
    appliesTo: 'sample',
    states: [
      { code: 'RECEIVED', name: 'Sample Received', type: 'initial' },
      { code: 'ANALYSIS', name: 'Under Analysis', type: 'normal' },
      { code: 'RELEASED', name: 'Report Released', type: 'final' },
    ],
    transitions: [
      { code: 'SUBMIT_ANALYSIS', name: 'Submit for Analysis', from: 'RECEIVED', to: 'ANALYSIS',
        creatorRoles: ['sample-manager', 'analyst'], approverRoles: ['lab-head'] },
      { code: 'RELEASE', name: 'Release Report', from: 'ANALYSIS', to: 'RELEASED',
        creatorRoles: ['lab-head', 'reviewer'], approverRoles: ['qa-approver'] },
    ],
  },
  {
    code: 'STANDARD-TEST-REQUEST-LIFECYCLE',
    name: 'Test Request Lifecycle',
    description: 'Analysis, review and quality approval of a test request.',
    appliesTo: 'test_request',
    states: [
      { code: 'ANALYSIS', name: 'Analysis in Progress', type: 'initial' },
      { code: 'REVIEW', name: 'Under Review', type: 'normal' },
      { code: 'APPROVED', name: 'Approved', type: 'final' },
    ],
    transitions: [
      { code: 'SUBMIT_REVIEW', name: 'Submit for Review', from: 'ANALYSIS', to: 'REVIEW',
        creatorRoles: ['analyst', 'lab-head'], approverRoles: ['reviewer'] },
      { code: 'APPROVE', name: 'Approve Result', from: 'REVIEW', to: 'APPROVED',
        creatorRoles: ['reviewer', 'lab-head'], approverRoles: ['qa-approver'] },
    ],
  },
  {
    code: 'STANDARD-INSTRUMENT-SERVICE-LIFECYCLE',
    name: 'Instrument Service Lifecycle',
    description: 'Recording, review and closure of an instrument service.',
    appliesTo: 'instrument_service',
    states: [
      { code: 'RECORDED', name: 'Service Recorded', type: 'initial' },
      { code: 'REVIEWED', name: 'Service Reviewed', type: 'normal' },
      { code: 'CLOSED', name: 'Service Closed', type: 'final' },
    ],
    transitions: [
      { code: 'REVIEW', name: 'Submit Service for Review', from: 'RECORDED', to: 'REVIEWED',
        creatorRoles: ['analyst', 'lab-head'], approverRoles: ['lab-head'] },
      { code: 'CLOSE', name: 'Close Service', from: 'REVIEWED', to: 'CLOSED',
        creatorRoles: ['lab-head', 'reviewer'], approverRoles: ['qa-approver'] },
    ],
  },
]);

/**
 * Per-state behaviour and role capabilities, mirroring PERN's
 * `seededWorkflowStatePolicy`: administrators can do everything at every
 * state, sample custodians and lab heads edit active samples, lab heads,
 * analysts and custodians allocate, analysts and lab heads record results, and
 * QA approvers, lab heads and custodians print reports once a sample is past
 * receipt. Node layout follows the same left-to-right zigzag as PERN.
 */
export function workflowStatePolicy(appliesTo, state, index, count, { roles = {}, administratorRoleIds = [] } = {}) {
  const unique = (...lists) => [...new Set(lists.flat().filter(Boolean))];
  const roleIds = (...codes) => codes.map((code) => roles[code]).filter(Boolean);
  const sampleState = appliesTo === 'sample'; const requestState = appliesTo === 'test_request';
  const activeState = state.type !== 'final';
  const allocationRoles = roleIds('lab-head', 'analyst', 'sample-manager');
  const resultRoles = roleIds('analyst', 'lab-head');
  const editRoles = roleIds('sample-manager', 'lab-head');
  const printRoles = roleIds('qa-approver', 'lab-head', 'sample-manager');
  return {
    displayOrder: index, canvasX: 80 + index * 260, canvasY: 100 + (index % 2) * 170,
    inputCount: index === 0 ? 0 : 1, outputCount: index === count - 1 ? 0 : 1, badgeStyle: 'light',
    showSampleEdit: sampleState && activeState,
    showSampleRetest: sampleState && state.type === 'final',
    showSampleReissue: sampleState && state.type === 'final',
    showAddResult: sampleState ? state.code === 'ANALYSIS' : requestState && state.code !== 'APPROVED',
    generateTestRequests: sampleState && ['RECEIVED', 'ANALYSIS'].includes(state.code),
    requireAllTestRequestsAllocated: false, requireAllTestRequestsApproved: false,
    fetchEnvironmentData: sampleState && state.code === 'ANALYSIS',
    canWorkOnTestRequest: (sampleState || requestState) && activeState,
    isPositiveTermination: state.type === 'final', enableJobCard: false,
    accessRoleIds: unique(administratorRoleIds, Object.values(roles)),
    editRoleIds: unique(administratorRoleIds, sampleState && activeState ? editRoles : []),
    allocateRoleIds: unique(administratorRoleIds, (sampleState || requestState) && activeState ? allocationRoles : []),
    addResultRoleIds: unique(administratorRoleIds, (sampleState || requestState) && activeState ? resultRoles : []),
    printCoaRoleIds: unique(administratorRoleIds, sampleState && state.code !== 'RECEIVED' ? printRoles : []),
  };
}

export const workflowByEntity = Object.freeze(Object.fromEntries(
  workflowDefinitions.map((definition) => [definition.appliesTo, definition]),
));
