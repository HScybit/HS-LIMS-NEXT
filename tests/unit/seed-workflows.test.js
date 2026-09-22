import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowDefinitions, workflowStatePolicy } from '../../src/seed/workflow-catalog.js';

const roles = { 'lab-head': 'r-head', analyst: 'r-analyst', 'sample-manager': 'r-manager', reviewer: 'r-reviewer', 'qa-approver': 'r-qa' };
const administratorRoleIds = ['r-admin'];

test('seeded workflows carry the PERN codes, states and transitions', () => {
  assert.deepEqual(workflowDefinitions.map((definition) => [definition.code, definition.appliesTo, definition.states.map((state) => state.code), definition.transitions.map((transition) => transition.code)]), [
    ['STANDARD-SAMPLE-LIFECYCLE', 'sample', ['RECEIVED', 'ANALYSIS', 'RELEASED'], ['SUBMIT_ANALYSIS', 'RELEASE']],
    ['STANDARD-TEST-REQUEST-LIFECYCLE', 'test_request', ['ANALYSIS', 'REVIEW', 'APPROVED'], ['SUBMIT_REVIEW', 'APPROVE']],
    ['STANDARD-INSTRUMENT-SERVICE-LIFECYCLE', 'instrument_service', ['RECORDED', 'REVIEWED', 'CLOSED'], ['REVIEW', 'CLOSE']],
  ]);
  for (const definition of workflowDefinitions) {
    assert.ok(definition.description);
    assert.deepEqual(definition.states.map((state) => state.type), ['initial', 'normal', 'final']);
  }
});

test('state layout zigzags left to right with closed ports at the ends', () => {
  const sample = workflowDefinitions[0];
  const layouts = sample.states.map((state, index) => workflowStatePolicy('sample', state, index, sample.states.length, { roles, administratorRoleIds }));
  assert.deepEqual(layouts.map(({ canvasX, canvasY, inputCount, outputCount, displayOrder, badgeStyle }) => [canvasX, canvasY, inputCount, outputCount, displayOrder, badgeStyle]),
    [[80, 100, 0, 1, 0, 'light'], [340, 270, 1, 1, 1, 'light'], [600, 100, 1, 0, 2, 'light']]);
});

test('sample state behaviour and capabilities follow the PERN policy', () => {
  const [received, analysis, released] = workflowDefinitions[0].states.map((state, index) => workflowStatePolicy('sample', state, index, 3, { roles, administratorRoleIds }));
  assert.deepEqual([received.showSampleEdit, analysis.showSampleEdit, released.showSampleEdit], [true, true, false]);
  assert.deepEqual([received.showSampleRetest, released.showSampleRetest, released.showSampleReissue], [false, true, true]);
  assert.deepEqual([received.showAddResult, analysis.showAddResult, released.showAddResult], [false, true, false]);
  assert.deepEqual([received.generateTestRequests, analysis.generateTestRequests, released.generateTestRequests], [true, true, false]);
  assert.deepEqual([received.fetchEnvironmentData, analysis.fetchEnvironmentData], [false, true]);
  assert.deepEqual([received.isPositiveTermination, released.isPositiveTermination], [false, true]);
  assert.deepEqual(received.accessRoleIds, ['r-admin', 'r-head', 'r-analyst', 'r-manager', 'r-reviewer', 'r-qa']);
  assert.deepEqual(received.editRoleIds, ['r-admin', 'r-manager', 'r-head']);
  assert.deepEqual(received.allocateRoleIds, ['r-admin', 'r-head', 'r-analyst', 'r-manager']);
  assert.deepEqual(received.addResultRoleIds, ['r-admin', 'r-analyst', 'r-head']);
  assert.deepEqual(received.printCoaRoleIds, ['r-admin']);
  assert.deepEqual(analysis.printCoaRoleIds, ['r-admin', 'r-qa', 'r-head', 'r-manager']);
  assert.deepEqual([released.editRoleIds, released.allocateRoleIds, released.addResultRoleIds], [['r-admin'], ['r-admin'], ['r-admin']]);
});

test('test request and instrument service states differ from sample states', () => {
  const [analysis, review, approved] = workflowDefinitions[1].states.map((state, index) => workflowStatePolicy('test_request', state, index, 3, { roles, administratorRoleIds }));
  assert.deepEqual([analysis.showAddResult, review.showAddResult, approved.showAddResult], [true, true, false]);
  assert.deepEqual([analysis.showSampleEdit, analysis.generateTestRequests, analysis.canWorkOnTestRequest, approved.canWorkOnTestRequest], [false, false, true, false]);
  const [recorded] = workflowDefinitions[2].states.map((state, index) => workflowStatePolicy('instrument_service', state, index, 3, { roles, administratorRoleIds }));
  assert.deepEqual([recorded.showAddResult, recorded.canWorkOnTestRequest, recorded.allocateRoleIds, recorded.accessRoleIds.length], [false, false, ['r-admin'], 6]);
});
