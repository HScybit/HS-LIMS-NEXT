import test from 'node:test';
import assert from 'node:assert/strict';
import { initialOccurrences, indexOccurrences } from '../../src/templates/occurrences.js';

const model = { groupsById: { outer: { id: 'outer', parentGroupId: null }, inner: { id: 'inner', parentGroupId: 'outer' } } };
const root = { id: 'root', groupId: null, parentId: null, position: 0 };
const outer = { id: 'outer-a', groupId: 'outer', parentId: 'root', position: '0' };

test('nested runtime occurrences keep exact sibling order and isolate their parent context', () => {
  const rows = [root, outer,
    { ...outer, id: 'outer-b', position: '1' },
    { id: 'second', groupId: 'inner', parentId: 'outer-a', position: '0.10000000000000002' },
    { id: 'first', groupId: 'inner', parentId: 'outer-a', position: '0.10000000000000001' },
    { id: 'other', groupId: 'inner', parentId: 'outer-b', position: '0' }];
  const before = JSON.stringify(rows);
  const index = indexOccurrences(model, rows);
  assert.equal(index.root.id, 'root');
  assert.deepEqual(index.forGroup('outer-a', 'inner').map((row) => row.id), ['first', 'second']);
  assert.deepEqual(index.forGroup('outer-b', 'inner').map((row) => row.id), ['other']);
  assert.deepEqual(index.forGroup('root', 'inner'), []);
  assert.equal(JSON.stringify(rows), before);
});

test('invalid, duplicate, missing, cyclic and oversized occurrence structures fail before rendering', () => {
  for (const rows of [[], [outer], [root, root], [root, { ...outer, parentId: 'missing' }], [root, { ...outer, groupId: 'unknown' }],
    [root, { ...outer, position: 'NaN' }], [root, { ...outer, position: '-1' }], Array(5001).fill(root)]) {
    assert.throws(() => indexOccurrences(model, rows), { code: 'repeat_structure' });
  }
  assert.throws(() => indexOccurrences({ groupsById: { loop: { parentGroupId: 'loop' } } }, [root,
    { id: 'one', parentId: 'two', groupId: 'loop', position: 0 }, { id: 'two', parentId: 'one', groupId: 'loop', position: 1 }]), { code: 'repeat_structure' });
});

const subjects = [{ testRequestId: 'request-a', specificationId: 'spec-a' }, { testRequestId: 'request-b', specificationId: 'spec-b' }];
function initial(groups, selected = subjects) {
  let next = 0;
  return initialOccurrences({ groupsById: Object.fromEntries(groups.map((group) => [group.id, { minimum: 1, maximum: 1000, ...group }])) },
    { rootId: 'root', newId: () => `occurrence-${++next}`, revision: 1, subjects: selected });
}

test('parameter loops bind distinct requests and nested measurement repeats inherit the correct child without cross products', () => {
  const groups = [{ id: 'parameters', parentGroupId: null, source: 'test_requests' },
    { id: 'measurements', parentGroupId: 'parameters', source: 'manual', minimum: 2 },
    { id: 'nested-parameter', parentGroupId: 'measurements', source: 'test_requests' }];
  const result = initial(groups);
  assert.equal(result.occurrences.length, 11); assert.equal(result.bindings.length, 6);
  const byId = new Map(result.occurrences.map((row) => [row.id, row]));
  for (const binding of result.bindings) byId.get(binding.occurrenceId).subject = binding;
  const runtime = indexOccurrences({ groupsById: Object.fromEntries(groups.map((group) => [group.id, group])) }, result.occurrences);
  const parameters = runtime.forGroup('root', 'parameters');
  assert.deepEqual(parameters.map((row) => runtime.subjectFor(row.id).testRequestId), ['request-a', 'request-b']);
  for (const parameter of parameters) for (const measurement of runtime.forGroup(parameter.id, 'measurements')) {
    const nested = runtime.forGroup(measurement.id, 'nested-parameter'); assert.equal(nested.length, 1);
    assert.equal(runtime.subjectFor(measurement.id).testRequestId, runtime.subjectFor(nested[0].id).testRequestId);
  }
});

test('separate manual parent occurrences receive complete subject sets, while missing, duplicate and oversized sets fail', () => {
  const groups = [{ id: 'runs', parentGroupId: null, source: 'manual', minimum: 2 }, { id: 'parameters', parentGroupId: 'runs', source: 'test_requests' }];
  const result = initial(groups);
  assert.equal(result.occurrences.length, 7);
  assert.deepEqual(result.bindings.map((binding) => binding.testRequestId), ['request-a', 'request-b', 'request-a', 'request-b']);
  assert.throws(() => initial(groups, []), { code: 'parameter_context_required' });
  assert.throws(() => initial(groups, [subjects[0], subjects[0]]), { code: 'duplicate_parameter_subject' });
  assert.throws(() => initial([{ id: 'parameters', parentGroupId: null, source: 'test_requests', maximum: 1 }]), { code: 'repeat_limit' });
  assert.throws(() => initial([{ id: 'runs', parentGroupId: null, source: 'manual', minimum: 1000 },
    { id: 'parameters', parentGroupId: 'runs', source: 'test_requests' }], Array.from({ length: 5 }, (_, index) => ({ testRequestId: `request-${index}`, specificationId: `spec-${index}` }))), { code: 'repeat_limit' });
});
