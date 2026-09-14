'use client';

import { useMemo } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { workflowCanvasModel, workflowNodeWidth, workflowPortTop } from '../../workflows/canvas.js';

export default function WorkflowCanvas({ states, transitions }) {
  const graph = useMemo(() => workflowCanvasModel(states, transitions), [states, transitions]);
  return <div className="workflow-canvas-shell" role="region" aria-label="Workflow canvas" tabIndex={0}>
    <div className="workflow-canvas" style={{ width: graph.width, height: graph.height }}>
      <svg className="workflow-lines" width={graph.width} height={graph.height} role="img" aria-label="Workflow connections">
        {graph.connections.map((connection) => connection.path ? <path key={connection.id} className="workflow-line" d={connection.path} style={{ cursor: 'default' }}>
          <title>{`${connection.sourceName} → ${connection.targetName}: ${connection.name}`}</title>
        </path> : null)}
      </svg>
      {!graph.nodes.length ? <div className="workflow-empty-state"><span className="workflow-empty-state__icon"><AppIcon name="activity" size={28} /></span><h2>No nodes yet</h2></div> : null}
      {graph.nodes.map((node) => <div key={node.id} className="workflow-node" data-state-id={node.id}
        style={{ left: node.layout.x, top: node.layout.y, width: workflowNodeWidth, height: node.layout.height, cursor: 'default' }}>
        {Array.from({ length: node.layout.inputCount }, (_, index) => <span key={index} className="workflow-port workflow-port--input"
          style={{ top: workflowPortTop(node.layout.height, node.layout.inputCount, index), cursor: 'default' }} title={`input_${index + 1}`} />)}
        <div className="workflow-node__content"><div className="workflow-node__title" title={node.name}>{node.name}</div>
          <div className="workflow-node__meta"><span>{node.layout.inputCount} in</span><span>{node.layout.outputCount} out</span></div>
        </div>
        {Array.from({ length: node.layout.outputCount }, (_, index) => <span key={index} className="workflow-port workflow-port--output"
          style={{ top: workflowPortTop(node.layout.height, node.layout.outputCount, index), cursor: 'default' }} title={`output_${index + 1}`} />)}
      </div>)}
    </div>
    <ul className="visually-hidden" aria-label="Workflow connection list">{graph.connections.map((connection) => <li key={connection.id}>
      {connection.path ? `${connection.sourceName} → ${connection.targetName}: ${connection.name}` : `${connection.name}: unavailable connection`}
    </li>)}</ul>
  </div>;
}
