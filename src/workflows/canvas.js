export const workflowNodeWidth = 176;

export function workflowNodeLayout(state) {
  const inputCount = state.inputCount ?? 1; const outputCount = state.outputCount ?? 1;
  const count = Math.max(inputCount, outputCount, 1);
  return { x: state.canvasX ?? 120, y: state.canvasY ?? 120, inputCount, outputCount,
    height: Math.max(122, 92 + count * 10 + (count - 1) * 6) };
}

export function workflowPortTop(height, count, index) {
  const ports = Math.max(count, 1);
  return (height - (ports * 10 + (ports - 1) * 6)) / 2 + index * 16;
}

export function workflowCanvasModel(states = [], transitions = []) {
  const nodes = states.map((state) => ({ ...state, layout: workflowNodeLayout(state) }));
  const byId = new Map(nodes.map((state) => [state.id, state]));
  const size = nodes.reduce((size, node) => ({ width: Math.max(size.width, node.layout.x + 520),
    height: Math.max(size.height, node.layout.y + 360) }), { width: 1200, height: 720 });
  const connections = transitions.map((transition) => {
    const source = byId.get(transition.sourceStateId); const target = byId.get(transition.targetStateId);
    if (!source || !target) return { ...transition, path: null };
    const from = source.layout; const to = target.layout;
    const sourcePort = transition.sourcePort ?? 1; const targetPort = transition.targetPort ?? 1;
    if (sourcePort > from.outputCount || targetPort > to.inputCount) return { ...transition, path: null };
    const x1 = from.x + workflowNodeWidth; const x2 = to.x;
    const y1 = from.y + workflowPortTop(from.height, from.outputCount, sourcePort - 1) + 5;
    const y2 = to.y + workflowPortTop(to.height, to.inputCount, targetPort - 1) + 5;
    const bend = Math.max(80, Math.abs(x2 - x1) / 2);
    return { ...transition, sourceName: source.name, targetName: target.name,
      path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` };
  });
  return { nodes, connections, ...size };
}
