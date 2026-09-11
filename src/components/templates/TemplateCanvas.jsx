'use client';

import { memo } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import ActionButtonGroup from '../ui/ActionButtonGroup.jsx';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { displayValue, valueKey } from '../../templates/calculations.js';

export const TemplateWidget = memo(function TemplateWidget({ field, mode = 'view', value, onCommit, occurrenceId, validation }) {
  const plan = mode === 'plan';
  const edit = mode === 'edit';
  const shown = displayValue(field, value);
  const label = field.alias || field.label || field.widget;
  if (field.widget === 'text_widget') return <div>{value?.state === 'present' ? value.textValue : field.label}</div>;
  if (field.widget === 'formula_widget') return plan ? <p className="text-break mb-0">{field.formula}</p> : <div className={edit ? 'formulaWidgetInput' : undefined} aria-label={label}>{shown}</div>;
  if (field.widget === 'checkbox_widget') return <Checkbox checked={Boolean(shown)} disabled={!edit} aria-label={label} onChange={edit ? (next) => onCommit?.(field.id, occurrenceId, next) : undefined} />;
  if (!plan && !edit) return <div>{String(shown ?? '')}</div>;
  const inputProps = { 'aria-label': label, disabled: plan, placeholder: field.placeholder || (plan ? 'This is placeholder' : ''),
    defaultValue: shown ?? '', onBlur: edit ? (event) => onCommit?.(field.id, occurrenceId, event.currentTarget.value) : undefined };
  let type = 'text';
  if (field.widget === 'paragraph_widget') type = 'textarea';
  if (field.widget === 'number_widget') { inputProps.type = 'number'; inputProps.step = 'any'; }
  if (field.widget === 'datepicker_widget') inputProps.type = 'date';
  if (field.widget === 'dropdown_widget') {
    type = 'dropdown'; inputProps.defaultValue = value?.optionId ?? '';
    inputProps.options = field.options.map((option) => ({ value: option.id, label: option.label }));
    inputProps.onBlur = undefined;
    inputProps.onChange = edit ? (event) => onCommit?.(field.id, occurrenceId, event.target.value) : undefined;
  }
  return <FormElement type={type} className="mb-0" inputProps={inputProps} message={validation?.errors[0]?.message} messageTone="error" />;
});

function MoveButton({ kind, id, direction, icon, label, onCommand, disabled }) {
  return <button type="button" className={`btn btn-sm ${kind === 'row' ? 'btn-secondary' : 'btn-warning'} template-edit-icon-button`} aria-label={label} title={label} disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onCommand({ type: 'move', kind, id, direction }); }}><AppIcon name={icon} /></button>;
}

// The markup/classes follow the source TemplateSectionNode, TemplateRowNode and TemplateColNode.
export default function TemplateCanvas({ model, mode = 'plan', editing = {}, onToggleEdit, onCommand, onPanel, selected, onSelect, busy = false, values = {}, occurrenceId, validation = {}, onCommit }) {
  const plan = mode === 'plan';
  function renderColumn(id, sectionId, isEditing) {
    const column = model.columnsById[id];
    const field = model.fieldsById[column.fieldId];
    const hasChildren = column.childSectionIds.length > 0;
    const key = field ? valueKey(field.id, occurrenceId) : null;
    if (!plan && validation[key]?.visible === false) return null;
    const widgetMode = isEditing ? 'plan' : plan ? 'view' : mode;
    return <div key={id} className={`${column.cssClass || (column.span ? `col-${column.span}` : 'col')} col-add-widget widget-col border-dark ${hasChildren ? 'has-child p-0' : 'py-10 no-child'} ${selected === id ? 'active' : ''}`}
      data-col-id={id} data-row-id={column.rowId} data-master-section-id={sectionId} onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
      {isEditing ? <div className="template-column-plan-controls">
        <div className="template-column-move-bar" aria-label="Move column"><MoveButton kind="column" id={id} direction={-1} icon="fa-arrow-left" label="Move column left" onCommand={onCommand} disabled={busy} /><MoveButton kind="column" id={id} direction={1} icon="fa-arrow-right" label="Move column right" onCommand={onCommand} disabled={busy} /></div>
        <div className="action-row template-edit-toolbar template-edit-toolbar--column template-column-action-row"><div className="template-edit-toolbar__content"><div className="template-edit-toolbar__cluster template-edit-toolbar__cluster--wide" role="group"><div className="template-column-actions">
          <ActionButtonGroup label={field?.widget || ''} items={[
            { key: 'delete', icon: <AppIcon name="fa-trash" />, danger: true, children: 'Delete', disabled: busy, onClick: () => onCommand({ type: 'delete', kind: 'column', id }) },
            { key: 'add', icon: <AppIcon name="fa-plus" />, children: 'Add', disabled: busy || Boolean(field), onClick: () => onCommand({ type: 'addSection', parentColumnId: id }) },
            { key: 'column', icon: <AppIcon name="fa-cogs" />, children: 'Column', disabled: busy, onClick: () => onPanel({ type: 'column', id }) },
            { key: 'widget', icon: <AppIcon name="fa-edit" />, children: 'Widget', disabled: busy || !field, onClick: () => onPanel({ type: 'widget', id }) },
          ]} />
        </div></div></div></div>
      </div> : null}
      {isEditing && field?.widget !== 'text_widget' && !field?.alias ? <div className="template-column-warning">Missing key</div> : null}
      <div className="row1">{field ? <TemplateWidget field={field} mode={widgetMode} value={values[key]} validation={validation[key]} onCommit={onCommit} occurrenceId={occurrenceId} /> : null}
        {column.childSectionIds.map(renderSection)}
      </div>
    </div>;
  }
  function renderRow(id, sectionId, isEditing) {
    const row = model.rowsById[id];
    return <div key={id} className={`widget-row m-0 align-items-center1 row flex-1 ${selected === id ? 'active' : ''}`} data-row-id={id} data-master-section-id={sectionId}
      onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
      {isEditing ? <div className="action-row template-edit-toolbar template-edit-toolbar--row template-row-action-row"><div className="template-edit-toolbar__content">
        <div className="template-edit-toolbar__cluster template-edit-toolbar__cluster--wide" role="group"><div className="template-edit-toolbar__cluster">
          <button className="btn mb-1 btn-light-danger text-danger row-offcanvas btn-sm template-edit-button" type="button" disabled={busy} onClick={() => onPanel({ type: 'row', id })}><AppIcon name="fa-cogs" className="me-2" /> Row</button>
          <button className="btn mb-1 btn-light-primary text-primary btn-sm template-edit-button template-edit-button--soft" type="button" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'row', id })}><AppIcon name="fa-clone" className="me-2" /> Clone</button>
        </div>{row.ownRepeatGroupId ? <span className="btn mb-1 btn-light-info text-primary btn-sm template-edit-button template-edit-button--soft"><AppIcon name="fa-copy" className="me-2" /> Cloneable</span> : null}</div>
        <div className="template-edit-move-controls" aria-label="Move row"><MoveButton kind="row" id={id} direction={-1} icon="fa-arrow-up" label="Move row up" onCommand={onCommand} disabled={busy} /><MoveButton kind="row" id={id} direction={1} icon="fa-arrow-down" label="Move row down" onCommand={onCommand} disabled={busy} /></div>
      </div></div> : null}
      {row.columnIds.map((columnId) => renderColumn(columnId, sectionId, isEditing))}
    </div>;
  }
  function renderSection(id) {
    const section = model.sectionsById[id];
    const isEditing = plan && Boolean(editing[id]);
    if (!plan && !section.visible) return null;
    return <div key={id} id={id} data-section-id={id} data-is-header={section.isHeader || undefined} data-is-footer={section.isFooter || undefined}
      className={`master-section ${section.parentColumnId ? 'sub-section' : 'base-section'} ${section.cssClass} param_table ${selected === id ? 'active' : ''} ${isEditing ? 'is-editing' : ''}`}
      onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
      {plan ? <div className="row action-row align-items-center template-edit-toolbar template-edit-toolbar--section"><div className="template-edit-toolbar__content">
        {isEditing ? <div className="template-edit-toolbar__cluster template-edit-toolbar__cluster--wide">
          <button type="button" className="btn mb-1 btn-light-info text-info container-offcanvas btn-sm template-edit-button" disabled={busy} onClick={() => onPanel({ type: 'section', id })}><AppIcon name="fa-cogs" className="me-2" /> Container</button>
          <button type="button" className="btn mb-1 btn-light-primary text-primary btn-sm template-edit-button template-edit-button--soft" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'section', id })}><AppIcon name="fa-clone" className="me-2" /> Clone</button>
        </div> : null}<div className="template-edit-toolbar__spacer" />
        <button type="button" className={`btn mb-1 btn-sm template-edit-button ${isEditing ? 'btn-light-success text-success template-edit-button--active' : 'btn-light'}`} onClick={(event) => { event.stopPropagation(); onToggleEdit(id); }}><AppIcon name="fa-edit" className="me-2" />Edit Mode {isEditing ? 'On' : 'Off'}</button>
      </div></div> : null}
      {section.rowIds.map((rowId) => renderRow(rowId, id, isEditing))}
    </div>;
  }
  return <div id="template-designer" className="template-render-canvas">{model.rootSectionIds.map(renderSection)}</div>;
}
