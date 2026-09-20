'use client';

import { useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';

const nodeIcons = { section: 'fa-layer-group', row: 'fa-bars', column: 'fa-table-columns', widget: 'fa-pen-ruler' };
const widgetLabel = (widget) => (widget ? widget.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Empty field');

function fieldLabel(model, column) {
  const field = model.fieldsById[column.fieldId];
  if (!field) return column.childSectionIds.length ? 'Container' : 'Empty';
  return field.label || field.alias || widgetLabel(field.widget);
}

// Native-HTML5 drag-and-drop, matching the reference designer's outline reorder
// (no drag/canvas library on either side — see the parity audit). Only
// same-type/same-parent siblings may be dropped onto one another; the actual
// reorder still goes through the existing move({direction:±1}) command one
// step at a time, so no new backend command or position model is introduced.
async function reorder(onCommand, kind, items, fromId, toId) {
  const fromIndex = items.indexOf(fromId);
  const toIndex = items.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
  const direction = toIndex > fromIndex ? 1 : -1;
  for (let step = 0; step < Math.abs(toIndex - fromIndex); step += 1) {
    // Each move must land before the next is computed, since position shifts after every call.
    if (!(await onCommand({ type: 'move', kind, id: fromId, direction }))) return;
  }
}

function OutlineItem({ id, type, label, meta, depth, selected, expanded, hasChildren, onToggle, onSelect, reorderKind, siblings, onCommand, busy, children, extra }) {
  const [dragOver, setDragOver] = useState(false);
  const canReorder = Boolean(reorderKind && !busy && siblings.length > 1);
  return <li className="template-studio-outline-node">
    <div className={`template-studio-outline-item ${selected ? 'is-selected' : ''} ${canReorder ? 'is-reorderable' : ''} ${dragOver ? 'is-drag-over' : ''}`} style={{ '--outline-depth': depth }}
      onDragOver={(event) => { if (canReorder && event.dataTransfer.types.includes(`text/outline-${reorderKind}`)) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!canReorder) return;
        event.preventDefault(); setDragOver(false);
        const fromId = event.dataTransfer.getData(`text/outline-${reorderKind}`);
        if (fromId && fromId !== id) reorder(onCommand, reorderKind, siblings, fromId, id);
      }}>
      {hasChildren ? <button type="button" className="template-studio-outline-toggle" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggle}>
        <AppIcon name={expanded ? 'fa-chevron-down' : 'fa-chevron-right'} size={12} />
      </button> : <span className="template-studio-outline-toggle-spacer" />}
      {canReorder ? <button type="button" className="template-studio-outline-drag-handle" draggable title="Drag to reorder"
        aria-label={`Reorder ${label}. Use the up and down arrow keys, or drag this handle.`}
        onDragStart={(event) => event.dataTransfer.setData(`text/outline-${reorderKind}`, id)}
        onKeyDown={(event) => {
          if (busy || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          onCommand({ type: 'move', kind: reorderKind, id, direction: event.key === 'ArrowUp' ? -1 : 1 });
        }}><AppIcon name="menu" size={15} /></button> : null}
      <button type="button" className="template-studio-outline-select" onClick={onSelect}>
        <AppIcon name={nodeIcons[type]} size={15} />
        <span className="template-studio-outline-label"><strong>{label}</strong><small>{meta}</small></span>
      </button>
      {extra}
    </div>
    {hasChildren && expanded ? <ul className="template-studio-outline-children">{children}</ul> : null}
  </li>;
}

function OutlineColumn({ id, model, depth, tree }) {
  const { selected, selectedPath, expandedIds, toggleExpanded, query, onSelect, onPanel, onCommand, busy } = tree;
  const column = model.columnsById[id];
  const field = model.fieldsById[column.fieldId];
  const position = model.rowsById[column.rowId].columnIds.indexOf(id) + 1;
  const span = Math.max(1, Math.min(12, column.span || Math.floor(12 / model.rowsById[column.rowId].columnIds.length) || 1));
  const hasChildren = Boolean(field) || column.childSectionIds.length > 0;
  const expanded = Boolean(query) || selectedPath.has(id) || expandedIds.has(id);
  const choose = () => { onSelect(id); onPanel({ type: 'column', id }); };
  return <OutlineItem id={id} type="column" label={`Column ${position}`} meta={`${span}/12 width`} depth={depth}
    selected={selected === id} expanded={expanded} hasChildren={hasChildren} onToggle={() => toggleExpanded(id)}
    onSelect={choose} siblings={[]} onCommand={onCommand} busy={busy}>
    {field ? <li className="template-studio-outline-node">
      <div className={`template-studio-outline-item ${selected === field.id ? 'is-selected' : ''}`} style={{ '--outline-depth': depth + 1 }}>
        <span className="template-studio-outline-toggle-spacer" />
        <button type="button" className="template-studio-outline-select" onClick={() => { onSelect(id); onPanel({ type: 'widget', id }); }}>
          <AppIcon name={nodeIcons.widget} size={15} />
          <span className="template-studio-outline-label"><strong>{fieldLabel(model, column)}</strong><small>{widgetLabel(field.widget)}</small></span>
        </button>
      </div>
    </li> : null}
    {column.childSectionIds.map((childId) => <OutlineSection key={childId} id={childId} model={model} depth={depth + 1} tree={tree}
      siblings={column.childSectionIds} />)}
  </OutlineItem>;
}

function OutlineRow({ id, sectionId, model, depth, tree }) {
  const { selected, selectedPath, expandedIds, toggleExpanded, query, onSelect, onPanel, onCommand, busy } = tree;
  const row = model.rowsById[id];
  const siblings = model.sectionsById[sectionId].rowIds;
  const expanded = Boolean(query) || selectedPath.has(id) || expandedIds.has(id);
  return <OutlineItem id={id} type="row" label={`Row ${siblings.indexOf(id) + 1}`} meta={`${row.columnIds.length} column${row.columnIds.length === 1 ? '' : 's'}`}
    depth={depth} selected={selected === id} expanded={expanded} hasChildren={row.columnIds.length > 0} onToggle={() => toggleExpanded(id)}
    onSelect={() => { onSelect(id); onPanel({ type: 'row', id }); }} reorderKind="row" siblings={siblings} onCommand={onCommand} busy={busy}>
    {row.columnIds.map((columnId) => <OutlineColumn key={columnId} id={columnId} model={model} depth={depth + 1} tree={tree} />)}
  </OutlineItem>;
}

function OutlineSection({ id, model, depth, tree, siblings }) {
  const { selected, selectedPath, expandedIds, toggleExpanded, query, onSelect, onPanel, onCommand, busy } = tree;
  const section = model.sectionsById[id];
  const expanded = Boolean(query) || selectedPath.has(id) || expandedIds.has(id);
  return <OutlineItem id={id} type="section" label={section.name || `Container ${siblings.indexOf(id) + 1}`}
    meta={section.parentColumnId ? 'Nested container' : 'Container'} depth={depth} selected={selected === id} expanded={expanded}
    hasChildren={section.rowIds.length > 0} onToggle={() => toggleExpanded(id)}
    onSelect={() => { onSelect(id); onPanel({ type: 'section', id }); }} reorderKind="section" siblings={siblings} onCommand={onCommand} busy={busy}>
    {section.rowIds.map((rowId) => <OutlineRow key={rowId} id={rowId} sectionId={id} model={model} depth={depth + 1} tree={tree} />)}
  </OutlineItem>;
}

function BuildGuide({ model, previewUrl }) {
  const steps = [
    { label: 'Add a container', detail: 'Containers group related content.', complete: model.rootSectionIds.length > 0 },
    { label: 'Shape the rows', detail: 'Split rows into the columns you need.', complete: Object.keys(model.rowsById).length > 0 && Object.keys(model.columnsById).length > 0 },
    { label: 'Add and configure fields', detail: 'Choose what users see or fill in.', complete: Object.keys(model.fieldsById).length > 0 },
  ];
  const completed = steps.filter((step) => step.complete).length;
  return <section className="template-studio-guide" aria-label="Build checklist">
    <div className="template-studio-panel-heading"><div><p>Getting started</p><h2>Build checklist</h2></div><span>{completed}/{steps.length}</span></div>
    <div className="template-studio-progress" aria-label={`${completed} of ${steps.length} setup steps complete`}><span style={{ width: `${(completed / steps.length) * 100}%` }} /></div>
    <ol className="template-studio-guide-list">
      {steps.map((step, index) => <li key={step.label} className={step.complete ? 'is-complete' : ''}>
        <span className="template-studio-guide-marker">{step.complete ? <AppIcon name="check" size={13} /> : index + 1}</span>
        <span><strong>{step.label}</strong><small>{step.detail}</small></span>
      </li>)}
    </ol>
    {previewUrl ? <a className="template-studio-preview-link" href={previewUrl} target="_blank" rel="noopener noreferrer">
      <AppIcon name="eye" size={16} /><span>Check the final preview</span><AppIcon name="external-link" size={14} />
    </a> : null}
  </section>;
}

// Ancestor ids of the selected node, so its branch opens automatically.
function pathTo(model, selectedId) {
  const path = new Set();
  if (!selectedId) return path;
  const visitSection = (id, ancestors) => {
    const section = model.sectionsById[id];
    if (!section) return false;
    const branch = [...ancestors, id];
    if (id === selectedId) { branch.forEach((entry) => path.add(entry)); return true; }
    return section.rowIds.some((rowId) => {
      const rowBranch = [...branch, rowId];
      if (rowId === selectedId) { rowBranch.forEach((entry) => path.add(entry)); return true; }
      return model.rowsById[rowId].columnIds.some((columnId) => {
        const columnBranch = [...rowBranch, columnId];
        if (columnId === selectedId) { columnBranch.forEach((entry) => path.add(entry)); return true; }
        return model.columnsById[columnId].childSectionIds.some((childId) => visitSection(childId, columnBranch));
      });
    });
  };
  model.rootSectionIds.some((id) => visitSection(id, []));
  return path;
}

export default function TemplateOutline({ model, selected, onSelect, onPanel, onCommand, busy, onClose, previewUrl }) {
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState(() => new Set(model.rootSectionIds.slice(0, 1)));
  const toggleExpanded = (id) => setExpandedIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const matches = (id) => {
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    const section = model.sectionsById[id];
    if (section?.name?.toLowerCase().includes(needle)) return true;
    return section?.rowIds.some((rowId) => model.rowsById[rowId].columnIds.some((columnId) => fieldLabel(model, model.columnsById[columnId]).toLowerCase().includes(needle)));
  };
  const tree = { selected, selectedPath: pathTo(model, selected), expandedIds, toggleExpanded, query, onSelect, onPanel, onCommand, busy };
  const visible = model.rootSectionIds.filter(matches);
  return <aside className="template-studio-sidebar template-studio-sidebar--outline" aria-label="Template outline">
    <div className="template-studio-sidebar__header">
      <div><p>Template map</p><h2>Outline</h2></div>
      {onClose ? <button type="button" className="template-studio-panel-close" aria-label="Close outline" onClick={onClose}><AppIcon name="close" size={18} /></button> : null}
    </div>
    <label className="template-studio-search">
      <AppIcon name="search" size={16} aria-hidden />
      <span className="visually-hidden">Search template outline</span>
      <input type="search" placeholder="Find a container or field" value={query} onChange={(event) => setQuery(event.target.value)} />
      {query ? <button type="button" aria-label="Clear outline search" onClick={() => setQuery('')}><AppIcon name="close" size={14} /></button> : null}
    </label>
    <div className="template-studio-outline-scroll">
      {visible.length ? <ul className="template-studio-outline-tree">
        {visible.map((id) => <OutlineSection key={id} id={id} model={model} depth={0} tree={tree} siblings={model.rootSectionIds} />)}
      </ul> : <div className="template-studio-outline-empty"><AppIcon name="search" size={20} /><span>No matching items</span></div>}
      <button type="button" className="template-studio-add-container" disabled={busy} onClick={() => onCommand({ type: 'addSection' })}><AppIcon name="plus" size={16} /><span>Add container</span></button>
    </div>
    <BuildGuide model={model} previewUrl={previewUrl} />
  </aside>;
}
