import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowCanvasModel, workflowDragPosition, workflowNodeLayout, workflowPortTop } from '../../src/workflows/canvas.js';

test('node movement retains grab offsets and rounds and bounds the source scroll-aware pointer delta', () => {
  const origin = { x: 120, y: 300 }; const start = { x: 137.25, y: 326.75 };
  assert.deepEqual(workflowDragPosition(origin, start, { x: 180.75, y: 227 }), { x: 164, y: 200 });
  assert.deepEqual(workflowDragPosition(origin, start, { x: -1000, y: -1000 }), { x: 8, y: 8 });
  assert.deepEqual(workflowDragPosition(origin, start, { x: 200000, y: 200000 }), { x: 100000, y: 100000 });
  const initial = workflowNodeLayout({ canvasX: 0, canvasY: null });
  assert.deepEqual(workflowDragPosition(initial, start, start), { x: 0, y: 120 });
  assert.deepEqual(workflowDragPosition(initial, start, { x: start.x + 60, y: start.y + 80 }), { x: 60, y: 200 });
  assert.deepEqual(origin, { x: 120, y: 300 });
});

test('workflow canvas preserves the source dimensions, zero coordinates and all eight ports', () => {
  assert.deepEqual(workflowCanvasModel(), { nodes: [], connections: [], width: 1200, height: 720 });
  assert.deepEqual(workflowNodeLayout({ canvasX: 0, canvasY: 100000, inputCount: 0, outputCount: 8 }),
    { x: 0, y: 100000, inputCount: 0, outputCount: 8, height: 214 });
  assert.equal(workflowPortTop(214, 8, 0), 46); assert.equal(workflowPortTop(214, 8, 7), 158);
  assert.equal(workflowPortTop(122, 1, 0), 56);
  assert.equal(workflowNodeLayout({ inputCount: 0, outputCount: 0 }).height, 122);
});

test('absent legacy layout uses display defaults without changing or backfilling the graph', () => {
  const states = [{ id: 'a', name: 'A', canvasX: null, canvasY: null, inputCount: null, outputCount: null,
    legacyTrState: '  allocated  ', capabilityRoles: [{ capability: 'view', roleId: 'hidden' }] }];
  const before = structuredClone(states); const graph = workflowCanvasModel(states);
  assert.deepEqual(states, before);
  assert.deepEqual(graph.nodes[0].layout, { x: 120, y: 120, inputCount: 1, outputCount: 1, height: 122 });
  assert.equal(graph.nodes[0].canvasX, null); assert.equal(graph.nodes[0].legacyTrState, '  allocated  ');
});

test('connection paths use stable state identities and exact source port geometry in both directions', () => {
  const states = [{ id: 'a', name: 'Same name', canvasX: 0, canvasY: 0, inputCount: 1, outputCount: 8 },
    { id: 'b', name: 'Same name', canvasX: 600, canvasY: 100, inputCount: 1, outputCount: 1 }];
  const transitions = [{ id: 'ab', name: 'Forward', sourceStateId: 'a', targetStateId: 'b', sourcePort: 8, targetPort: 1 },
    { id: 'ba', name: 'Backward', sourceStateId: 'b', targetStateId: 'a' }];
  const graph = workflowCanvasModel(states, transitions);
  assert.equal(graph.connections[0].path, 'M 176 163 C 388 163, 388 161, 600 161');
  assert.equal(graph.connections[1].path, 'M 776 161 C 1164 161, -388 107, 0 107');
  assert.deepEqual(workflowCanvasModel([...states].reverse(), transitions).connections, graph.connections);
});

test('unavailable endpoints and removed ports remain explicit connections without misleading paths', () => {
  const states = [{ id: 'a', canvasX: 100000, canvasY: 100000, inputCount: 0, outputCount: 0 }];
  const transitions = [{ id: 'missing', sourceStateId: 'a', targetStateId: 'unknown' },
    { id: 'removed', sourceStateId: 'a', targetStateId: 'a', sourcePort: 1 }];
  const graph = workflowCanvasModel(states, transitions);
  assert.equal(graph.width, 100520); assert.equal(graph.height, 100360);
  assert.deepEqual(graph.connections.map((connection) => connection.path), [null, null]);
  assert.equal(graph.connections.length, transitions.length);
});
