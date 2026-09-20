import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowAllowedActions } from '../../src/workflows/access.js';

test('workflow access preserves unconfigured permission fallback and configured role/flag requirements', () => {
  const identity = { permission_codes: ['samples.read', 'datasheets.execute', 'test_requests.allocate'] };
  const state = { show_sample_edit: false, show_add_result: false, can_work_on_test_request: false };
  const fallback = workflowAllowedActions(identity, state);
  assert.equal(fallback.allowedActions.addResult, true);
  assert.equal(fallback.allowedActions.allocate, true);
  assert.equal(fallback.allowedActions.edit, false);
  assert.equal(fallback.allowedActions.workOnTestRequest, true);
  const configured = workflowAllowedActions(identity, state, [{ capability: 'execute', is_allowed: true }, { capability: 'allocate', is_allowed: false }]);
  assert.equal(configured.allowedActions.addResult, false);
  assert.equal(configured.allowedActions.allocate, false);
  assert.equal(configured.allowedActions.view, true);
  assert.equal(configured.allowedActions.workOnTestRequest, false);
  const enabled = workflowAllowedActions({ permission_codes: [] }, { ...state, show_add_result: true }, [{ capability: 'execute', is_allowed: true }]);
  assert.equal(enabled.allowedActions.addResult, true);
  assert.equal(workflowAllowedActions({ permission_codes: [] }, null).allowedActions.view, false);
});
