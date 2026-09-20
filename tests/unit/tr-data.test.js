import test from 'node:test';
import assert from 'node:assert/strict';
import { trDataText, trDataValue, trDataUuid } from '../../src/templates/tr-data.js';

const context = () => ({ request: { uuid: 'TR-001', assignee_id: 'analyst', approver_id: 'reviewer', final_approver_id: 'final', allocated_by: 'allocator',
  current_state: 'approved', allocation_date: 'allocated', reviewed_at: 'reviewed', approval_date: 'approved', final_approval_date: 'finalized', submission_date: 'submitted' },
  usersById: { analyst: 'Assigned analyst', reviewer: 'Assigned reviewer', final: 'Assigned final approver', allocator: 'Actual allocator' },
  method: { id: 'method', name: 'Selected method' }, parameter: { id: 'parameter', name: 'Selected parameter' }, product: { id: 'product', name: 'Selected product' } });

test('TR Data uses assigned actors and exact source approval-state gates', () => {
  const value = context();
  for (const state of ['allocated', 'reviewed', 'approved', 'Approved', ' approved ', '', null]) {
    value.request.current_state = state;
    assert.equal(trDataValue('analyst', value), 'Assigned analyst');
    assert.equal(trDataValue('allocated_to', value), 'Assigned analyst');
    assert.equal(trDataValue('approver', value), ['reviewed', 'approved'].includes(state) ? 'Assigned reviewer' : '');
    assert.equal(trDataValue('final_approver', value), state === 'approved' ? 'Assigned final approver' : '');
    assert.equal(trDataValue('allocated_by', value), 'Actual allocator');
  }
  delete value.request.allocated_by; assert.equal(trDataValue('allocated_by', value), 'Assigned final approver');
  value.request.allocated_by = 'missing'; assert.equal(trDataValue('allocated_by', value), '');
  value.request.assignee_id = 'missing'; assert.equal(trDataValue('analyst', value), '');
});

test('TR scientific aliases distinguish missing names from identifier fallbacks', () => {
  const value = context();
  for (const [key, property] of [['moa', 'method'], ['param', 'parameter'], ['product', 'product']]) {
    assert.equal(trDataValue(key, value), value[property].name);
    assert.equal(trDataValue(`${key}_id`, value), value[property].name);
    delete value[property].name;
    assert.equal(trDataValue(key, value), ''); assert.equal(trDataValue(`${key}_id`, value), value[property].id);
    delete value[property]; assert.equal(trDataValue(`${key}_id`, value), '');
  }
});

test('TR dates select actual fields and preserve source reviewed-at fallback rules', () => {
  const value = context(); const date = (value) => value == null ? '' : `date(${value})`;
  for (const [key, expected] of [['allocation_date', 'allocated'], ['approval_date', 'reviewed'], ['final_approval_date', 'finalized'], ['submission_date', 'submitted']]) {
    assert.equal(trDataValue(key, value, date), `date(${expected})`);
  }
  for (const absent of [undefined, null, '', 0, false]) { value.request.reviewed_at = absent; assert.equal(trDataValue('approval_date', value, date), 'date(approved)'); }
  value.request.reviewed_at = ' '; assert.equal(trDataValue('approval_date', value, date), 'date( )');
});

test('TR text preserves zero, false, array holes, duplicates and object display without prototype traversal', () => {
  const value = context();
  for (const raw of [0, false, '', '-', ['same', '', 0, false, null, 'same'], { value: 0 }]) {
    value.request.custom = raw; assert.equal(trDataValue('custom', value), raw);
  }
  assert.equal(trDataText([null, '', 0, false, undefined, 'same', 'same']), ', , 0, false, , same, same');
  assert.equal(trDataText({ value: 0 }), '{"value":0}');
  assert.equal(trDataText(new Date('2026-01-01T00:00:00Z')), '"2026-01-01T00:00:00.000Z"');
  const cyclic = {}; cyclic.self = cyclic; assert.equal(trDataText(cyclic), '[object Object]');
  for (const raw of [null, undefined]) assert.equal(trDataText(raw), '');
  assert.equal(trDataText(false), 'false'); assert.equal(trDataText(0), '0');
  assert.equal(trDataText('<strong>Exact text</strong>'), '<strong>Exact text</strong>');
  for (const key of ['__proto__', 'constructor', 'toString', 'request.uuid', 'unknown']) assert.equal(trDataValue(key, value), '');
  assert.equal(trDataValue('uuid', { request: Object.create({ uuid: 'inherited' }) }), '');
  assert.equal(trDataValue('analyst', { request: { assignee_id: 'inherited' }, usersById: Object.create({ inherited: 'Wrong actor' }) }), '');
  assert.equal(trDataValue('uuid', null), '');
});

test('TR UUID aggregation preserves recorded order, duplicate jobs and the first selected parameter', () => {
  const requests = [
    { product_unique_id: 'line', param_id: 'first', uuid: 'TR-B', is_job: false },
    { product_unique_id: 'line', param_id: 'second', uuid: 'TR-A', is_job: false },
    { product_unique_id: 'other', param_id: 'first', uuid: 'Foreign line', is_job: true },
    { product_unique_id: 'line', uuid: 'JOB-2', is_job: true }, { product_unique_id: 'line', uuid: 'JOB-2', is_job: true },
  ];
  assert.equal(trDataUuid(requests, { productLineId: 'line', reportType: 'product_wise' }), 'JOB-2, JOB-2');
  assert.equal(trDataUuid(requests, { productLineId: 'line', reportType: 'parameter_wise', parameterId: 'first' }), 'TR-B');
  assert.equal(trDataUuid(requests.slice(0, 2), { productLineId: 'line', reportType: 'product_wise' }), 'TR-B, TR-A');
  assert.equal(trDataUuid(requests, { reportType: 'consolidated' }), '');
  assert.equal(trDataUuid([], { productLineId: 'line' }), '');
  assert.equal(trDataUuid([{ product_unique_id: 'line', uuid: '' }], { productLineId: 'line' }), '');
});
