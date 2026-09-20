/**
 * Workflow masters, ported from PERN's `workflowV3Catalog.js`.
 *
 * Role codes are the shared catalog's role refs with underscores replaced, so
 * `qa_approver` is named here as `qa-approver`. A transition that lists
 * approver roles raises a real approval request when it is asked for; one that
 * lists none applies as soon as its creator asks.
 */
export const workflowDefinitions = Object.freeze([
  {
    code: 'STANDARD-SAMPLE-LIFECYCLE',
    name: 'Sample Lifecycle',
    description: 'Receipt, analysis and release of a laboratory sample.',
    appliesTo: 'sample',
    states: [
      { code: 'RECEIVED', name: 'Sample Received', type: 'initial' },
      // Test requests are generated once a sample is under analysis.
      { code: 'ANALYSIS', name: 'Under Analysis', type: 'normal', generateTestRequests: true },
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

export const workflowByEntity = Object.freeze(Object.fromEntries(
  workflowDefinitions.map((definition) => [definition.appliesTo, definition]),
));
