import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowPublicationProblem } from '../../src/workflows/publication.js';

const graph = () => ({ states: [{ id: 'start', stateType: 'initial' }, { id: 'end', stateType: 'final' }],
  transitions: [{ sourceStateId: 'start', targetStateId: 'end', approvalMode: 'none', approverStages: [] }] });

test('empty, missing terminal and disconnected graphs remain drafts', () => {
  assert(workflowPublicationProblem({ states: [], transitions: [] }));
  for (const states of [[{ id: 'start', stateType: 'initial' }], [{ id: 'end', stateType: 'final' }]]) {
    assert(workflowPublicationProblem({ states, transitions: [] }));
  }
  const value = graph(); value.states.push({ id: 'middle', stateType: 'normal' });
  assert(workflowPublicationProblem(value));
  value.transitions.push({ sourceStateId: 'middle', targetStateId: 'end', approvalMode: 'none' });
  assert.equal(workflowPublicationProblem(value), null);
  value.states.push({ id: 'cancelled', stateType: 'cancelled' });
  assert.equal(workflowPublicationProblem(value), null);
});

test('approval activation requires role stages consistent with none, any, all and sequential modes', () => {
  const value = graph(); const edge = value.transitions[0];
  assert.equal(workflowPublicationProblem(value), null);
  edge.approverStages = [{ stageNumber: 1, roleIds: ['role'] }];
  assert(workflowPublicationProblem(value));
  for (const mode of ['any', 'all', 'sequential']) {
    edge.approvalMode = mode; assert.equal(workflowPublicationProblem(value), null);
    edge.approverStages = []; assert(workflowPublicationProblem(value));
    edge.approverStages = [{ stageNumber: 1, roleIds: [] }]; assert(workflowPublicationProblem(value));
    edge.approverStages = [{ stageNumber: 1, roleIds: ['role'] }];
  }
  edge.approverStages.push({ stageNumber: 3, roleIds: ['another'] });
  assert.equal(workflowPublicationProblem(value), null);
  edge.approvalMode = 'all'; assert(workflowPublicationProblem(value));
});
