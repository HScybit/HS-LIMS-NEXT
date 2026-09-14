'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { workflowCanvasModel, workflowDragPosition, workflowNodeWidth, workflowPortTop } from '../../workflows/canvas.js';

export default function WorkflowCanvas({ states, transitions, onEditNode, onDeleteNode, onMoveNode, onDragChange, moving = false, disabled = false }) {
  const shell = useRef(null); const drag = useRef(null); const [preview, setPreview] = useState(null);
  const canMove = Boolean(onMoveNode) && !disabled;
  const graph = useMemo(() => workflowCanvasModel(preview?.states === states
    ? states.map((state) => state.id === preview.id ? { ...state, canvasX: preview.x, canvasY: preview.y } : state) : states, transitions), [states, transitions, preview]);
  useEffect(() => () => drag.current?.cancel(), [states, canMove]);
  function startDrag(event, node) {
    if (!canMove || drag.current || event.button !== 0 || !event.isPrimary || event.target.closest('button, .workflow-port')) return;
    const element = event.currentTarget; const container = shell.current; const pointerId = event.pointerId;
    const point = (event) => { const bounds = container.getBoundingClientRect(); return {
      x: event.clientX - bounds.left + container.scrollLeft, y: event.clientY - bounds.top + container.scrollTop,
    }; };
    const origin = { x: node.layout.x, y: node.layout.y }; const start = point(event); let position = origin;
    function move(event) {
      if (event.pointerId !== pointerId) return;
      if (event.buttons === 0) { cancel(); return; }
      position = workflowDragPosition(origin, start, point(event));
      setPreview((current) => current?.states === states && current.id === node.id && current.x === position.x && current.y === position.y
        ? current : { states, id: node.id, ...position });
    }
    function cleanup() {
      drag.current = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape);
      element.removeEventListener('lostpointercapture', cancelPointer);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      onDragChange?.(false);
    }
    function cancel() { cleanup(); setPreview(null); }
    function cancelPointer(event) { if (event.pointerId === pointerId) cancel(); }
    function escape(event) { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }
    function stop(event) {
      if (event.pointerId !== pointerId) return;
      position = workflowDragPosition(origin, start, point(event)); cleanup();
      if (position.x === origin.x && position.y === origin.y) { setPreview(null); return; }
      setPreview({ states, id: node.id, ...position });
      void Promise.resolve(onMoveNode(node.id, position)).then((outcome) => { if (outcome === 'failed') setPreview(null); }, () => setPreview(null));
    }
    event.preventDefault(); element.setPointerCapture(pointerId); drag.current = { cancel }; onDragChange?.(true);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', cancelPointer); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape);
    element.addEventListener('lostpointercapture', cancelPointer);
  }
  return <div ref={shell} className="workflow-canvas-shell" role="region" aria-label="Workflow canvas" tabIndex={0}>
    <div className="workflow-canvas" style={{ width: graph.width, height: graph.height }}>
      <svg className="workflow-lines" width={graph.width} height={graph.height} role="img" aria-label="Workflow connections">
        {graph.connections.map((connection) => connection.path ? <path key={connection.id} className="workflow-line" d={connection.path} style={{ cursor: 'default' }}>
          <title>{`${connection.sourceName} → ${connection.targetName}: ${connection.name}`}</title>
        </path> : null)}
      </svg>
      {!graph.nodes.length ? <div className="workflow-empty-state"><span className="workflow-empty-state__icon"><AppIcon name="activity" size={28} /></span><h2>No nodes yet</h2></div> : null}
      {graph.nodes.map((node) => <div key={node.id} className="workflow-node" data-state-id={node.id}
        onPointerDown={(event) => startDrag(event, node)}
        onDoubleClick={(event) => { if (!disabled && !event.target.closest('button, .workflow-port')) onEditNode?.(node); }}
        style={{ left: node.layout.x, top: node.layout.y, width: workflowNodeWidth, height: node.layout.height,
          cursor: canMove ? 'move' : 'default', touchAction: canMove ? 'none' : undefined }}>
        {Array.from({ length: node.layout.inputCount }, (_, index) => <span key={index} className="workflow-port workflow-port--input"
          style={{ top: workflowPortTop(node.layout.height, node.layout.inputCount, index), cursor: 'default' }} title={`input_${index + 1}`} />)}
        <div className="workflow-node__content"><div className="workflow-node__title" title={node.name}>{node.name}</div>
          <div className="workflow-node__meta"><span>{node.layout.inputCount} in</span><span>{node.layout.outputCount} out</span></div>
          {onEditNode || onDeleteNode ? <div className="workflow-node__actions">
            {onEditNode ? <button type="button" disabled={disabled || moving} aria-label={`Edit ${node.name}`} onClick={() => onEditNode(node)}><AppIcon name="edit" /></button> : null}
            {onDeleteNode ? <button type="button" disabled={disabled || moving} aria-label={`Delete ${node.name}`} onClick={() => onDeleteNode(node)}><AppIcon name="trash" /></button> : null}
          </div> : null}
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
