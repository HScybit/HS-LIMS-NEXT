import test from 'node:test';
import assert from 'node:assert/strict';
import { indexOccurrences } from '../../src/templates/occurrences.js';

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
