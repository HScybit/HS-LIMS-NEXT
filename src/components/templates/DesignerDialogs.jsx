'use client';

import { useEffect, useId, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { widgetTypes } from '../../templates/input.js';
import { imageLayoutLabels } from '../../templates/image-config.js';
import { contextWidgetFields, isContextWidget } from '../../templates/context-widgets.js';
import { fieldDefaultValue } from '../../templates/defaults.js';
import { copySection } from './section-clipboard.js';
import { apiRequest } from '../../lib/api-client.js';

function useTemplateFieldRoleOptions(active) {
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    apiRequest('/api/templates/role-options').then((rows) => { if (!cancelled) setRoles(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);
  return roles;
}

const widgetOptions = Object.keys(widgetTypes).map((value) => ({ value, label: value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()) })).sort((a, b) => a.label.localeCompare(b.label));

function Toggle({ label, checked, onChange, wide = false }) {
  return <label className={`template-designer-toggle-card${wide ? ' template-designer-toggle-card--wide' : ''}`}><input className="form-check-input" type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

// Row/Container quick-action list — the panel a designer lands on first after clicking
// "Row" or "Container" on the canvas; "Configure" drills into the full settings form below.
function QuickActions({ panel, model, onPanel, onCommand, busy }) {
  const isRow = panel.type === 'row';
  const item = isRow ? model.rowsById[panel.id] : model.sectionsById[panel.id];
  const kind = isRow ? 'row' : 'section';
  const [cssClass, setCssClass] = useState(item?.cssClass || '');
  const otherSections = isRow ? Object.values(model.sectionsById).filter((section) => section.id !== item?.sectionId) : [];
  const [moveTarget, setMoveTarget] = useState('');
  function action(label, icon, command, className = '') {
    return <button key={label} type="button" disabled={busy} className={`btn ${isRow ? 'btn-light text-start template-row-config-action' : 'btn-icon template-container-config-action'} ${className}`} onClick={() => onCommand(command)}><AppIcon name={icon} className="me-2" />{label}</button>;
  }
  if (!item) return <div className="alert alert-warning">Select an item to configure it.</div>;
  return <div className={isRow ? 'template-row-config-actions' : 'template-container-config-actions'}>
    {isRow ? <section className="template-row-config-group"><div className="template-row-config-group__header"><span>Position</span><small>Move this row within the current container.</small></div><div className="template-row-config-action-row">
      {action('Move Up', 'fa-arrow-up', { type: 'move', kind, id: item.id, direction: -1 })}{action('Move Down', 'fa-arrow-down', { type: 'move', kind, id: item.id, direction: 1 })}
    </div></section> : <button type="button" disabled={busy} className="container-setting btn btn-icon btn-warning template-container-config-action" onClick={() => onPanel({ type: 'sectionSettings', id: item.id })}><AppIcon name="fa-cogs" className="me-2" />Configure</button>}
    {isRow ? <section className="template-row-config-group"><div className="template-row-config-group__header"><span>Appearance</span><small>Set the row&apos;s CSS class.</small></div>
      <div className="template-row-config-action-row"><FormElement type="text" inputProps={{ value: cssClass, placeholder: 'e.g. border border-bottom', onChange: (event) => setCssClass(event.target.value) }} />
        <button type="button" className="btn btn-sm btn-light-primary text-primary" disabled={busy} onClick={() => onCommand({ type: 'configureRow', id: item.id, cssClass })}>Save</button>
      </div></section> : null}
    {isRow && otherSections.length ? <section className="template-row-config-group"><div className="template-row-config-group__header"><span>Move to Container</span><small>Relocate this row into another container.</small></div>
      <div className="template-row-config-action-row"><FormElement type="searchable-select" inputProps={{ value: moveTarget, placeholder: 'Select a container…', onChange: (value) => setMoveTarget(value || ''),
        options: otherSections.map((section) => ({ value: section.id, label: section.name || 'Container' })) }} />
        <button type="button" className="btn btn-sm btn-light-primary text-primary" disabled={busy || !moveTarget} onClick={() => onCommand({ type: 'moveRowToSection', id: item.id, sectionId: moveTarget })}>Move</button>
      </div></section> : null}
    {!isRow ? <button type="button" disabled={busy} className="btn btn-icon btn-light-info text-info template-container-config-action"
      onClick={() => copySection({ versionId: model.version.id, sectionId: item.id, label: item.name || 'Container' })}><AppIcon name="fa-copy" className="me-2" />Copy Container</button> : null}
    {action(isRow ? 'Clone Row' : 'Clone Container', 'fa-clone', { type: 'clone', kind, id: item.id }, isRow ? 'btn-light-primary text-primary' : 'btn-primary')}
    {action(isRow ? 'Add New Column' : 'Add Row', 'fa-plus', isRow ? { type: 'addColumn', rowId: item.id } : { type: 'addRow', sectionId: item.id }, isRow ? 'btn-light-primary text-primary' : 'btn-success')}
    {isRow ? action(item.ownRepeatGroupId ? 'Disable Cloneable Row' : 'Make Cloneable', 'fa-copy', { type: 'repeatRow', id: item.id, enabled: !item.ownRepeatGroupId }, 'btn-light-info text-info') : null}
    {action(isRow ? 'Delete Row' : 'Delete Container', 'fa-trash', { type: 'delete', kind, id: item.id }, isRow ? 'btn-light-danger text-danger template-row-config-action--danger' : 'btn-danger template-container-config-action--danger')}
  </div>;
}

// The detailed settings form for a widget, column or container — reached either directly
// (Column/Widget buttons on the canvas) or by drilling into QuickActions' "Configure".
function SettingsForm({ panel, model, onCommand, onSaved, busy, formId }) {
  const roleOptions = useTemplateFieldRoleOptions(['widget', 'column'].includes(panel.type));
  const column = model.columnsById[panel.id];
  const field = model.fieldsById[column?.fieldId];
  const section = model.sectionsById[panel.id];
  const [form, setForm] = useState(() => {
    if (panel.type === 'widget') return { type: 'configureField', columnId: column.id, widget: field.widget, alias: field.alias, label: field.label, placeholder: field.placeholder, required: field.required, editable: field.editable,
      displayScale: field.numeric?.displayScale ?? '', padDecimals: field.numeric?.padDecimals ?? false, minimum: field.numeric?.minimum ?? '', maximum: field.numeric?.maximum ?? '',
      sourceField: field.sourceField ?? null, serialPadding: field.serialPadding ?? null,
      ...(field.widget === 'sample_line_item_data_widget' ? { attributeKey: field.attributeKey ?? '' } : {}),
      ...(field.widget === 'template_image_widget' ? { image: Object.fromEntries(Object.keys(imageLayoutLabels).map((key) => [key, field.image?.[key] ?? ''])) } : {}),
      ...(field.widget === 'result_widget' ? { defaultValue: fieldDefaultValue(field) ?? '' } : {}),
      ...(['product_detail_widget', 'sample_line_item_data_widget', 'vertical_text_widget', 'parameter_detail_widget', 'tr_data_widget'].includes(field.widget) ? { defaultValue: field.defaultText ?? '' } : {}),
      ...(field.widget === 'formula_widget' ? { formula: field.formula ?? '', formulaOnMissingValue: field.formulaOnMissingValue ?? 'error', formulaOnError: field.formulaOnError ?? 'show_error' } : {}), options: field.options.map((option) => option.value),
      editRoleIds: field.editRoleIds ?? [], viewRoleIds: field.viewRoleIds ?? [] };
    if (panel.type === 'column') return { type: 'configureColumn', id: column.id, indexValue: column.indexValue || '', masterValue: column.masterValue || '', cssClass: column.cssClass || '', widget: field?.widget || 'text_widget',
      editRoleIds: field?.editRoleIds ?? [], viewRoleIds: field?.viewRoleIds ?? [], showInCoa: column.showInCoa ?? true, showInTemplate: column.showInTemplate ?? true,
      isFinalResult: column.isFinalResult, showInNabl: column.showInNabl, showInNonNabl: column.showInNonNabl };
    return { type: 'configureSection', id: section.id, name: section.name, cssClass: section.cssClass, visible: section.visible, isHeader: section.isHeader, isFooter: section.isFooter, isFinalResult: section.isFinalResult, isParameterLoop: section.isParameterLoop, isParameterLoopHeader: section.isParameterLoopHeader, showInNabl: section.showInNabl, showInNonNabl: section.showInNonNabl };
  });
  const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const title = { widget: 'Widget Configuration', column: 'Column Settings', sectionSettings: 'Container Settings' }[panel.type];
  async function submit(event) { event.preventDefault(); if (await onCommand(form)) onSaved?.(); }
  function input(key, label, type = 'text', extra = {}) {
    return <FormElement key={key} type={type} label={label} inputProps={{ value: form[key] ?? '', onChange: (event) => update(key, event.target.value), ...extra }} />;
  }
  return <form id={formId} onSubmit={submit} autoComplete="off" className="template-designer-form">
    <div className="template-properties-dock__section-title"><AppIcon name={panel.type === 'widget' ? 'edit' : 'settings'} size={16} /><h3>{title}</h3></div>
    {panel.type === 'widget' ? <>
      <section className="template-designer-form-section template-studio-widget-type-section"><div className="template-designer-form-section__header"><h3>What should this field do?</h3><p>Review the field type, then configure only the settings that field needs.</p></div><FormElement type="searchable-select" label="Field type" inputProps={{ value: form.widget, options: widgetOptions, disabled: true, placeholder: 'Search field types' }} /></section>
      <section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Behavior</h3><p>Configure the widget key and how this field behaves inside the template.</p></div><Toggle label="Required" checked={form.required} onChange={(value) => update('required', value)} /></section>
      <section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Fields</h3><p>Identifiers must be unique across the template.</p></div><div className="template-designer-form-grid template-designer-form-grid--single">
        {['text_widget', 'vertical_text_widget', 'product_detail_widget', 'parameter_detail_widget', 'tr_data_widget', 'tr_result_widget', 'decision_rule_widget'].includes(form.widget) ? input('label', 'Title') : null}{input('alias', 'Key')}
        {form.widget === 'product_detail_widget' ? input('defaultValue', 'Default Value') : null}
        {form.widget === 'sample_line_item_data_widget' ? input('attributeKey', 'Attribute Name/Key') : null}
        {['vertical_text_widget', 'parameter_detail_widget', 'sample_line_item_data_widget', 'tr_data_widget'].includes(form.widget) ? <FormElement type="text" label="Default Value" inputProps={{ value: form.defaultValue, placeholder: 'Default value', onChange: (event) => update('defaultValue', event.target.value) }}
          helperText={<small className="text-muted">Use &quot;-&quot; to keep this default as blank / null.</small>} /> : null}
        {form.widget === 'text_widget' ? <FormElement type="text" label="Default Value" inputProps={{ value: form.label || field.defaultText || '', placeholder: 'Default value', disabled: true }}
          helperText={<small className="text-muted">For text widgets, default value is always the title.</small>} /> : null}
        {form.widget === 'template_image_widget' ? Object.entries(imageLayoutLabels).map(([key, label]) => <FormElement key={key} type="text" label={label}
          inputProps={{ value: form.image[key], onChange: (event) => update('image', { ...form.image, [key]: event.target.value }) }} />) : null}
        {isContextWidget(form.widget) && form.widget !== 'sample_line_item_data_widget' && contextWidgetFields[form.widget].length ? <FormElement type="searchable-select" label={form.widget === 'sample_details_widget_v2' ? 'Sample Attribute' : 'Data Field'} inputProps={{ value: form.sourceField ?? '', options: contextWidgetFields[form.widget].map((value) => ({ value, label: value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()) })), placeholder: 'Select field', onChange: (value) => update('sourceField', value || null) }} /> : null}
        {form.widget === 'sno_widget' ? input('serialPadding', '0 Padding', 'text', { type: 'number', min: 0, max: 100, onChange: (event) => update('serialPadding', event.target.value === '' ? null : Number(event.target.value)) }) : null}
        {['input_widget', 'number_widget', 'paragraph_widget', 'result_widget', 'checkbox_widget'].includes(form.widget) ? input('placeholder', form.widget === 'checkbox_widget' ? 'Checkbox name' : 'Placeholder') : null}
        {['number_widget', 'result_widget'].includes(form.widget) ? <>
          {input('minimum', 'Minimum', 'text', { type: 'number', step: 'any' })}
          {input('maximum', 'Maximum', 'text', { type: 'number', step: 'any' })}
          {input('displayScale', 'Decimal Points', 'text', { type: 'number', min: 0, max: 100, onChange: (event) => update('displayScale', event.target.value === '' ? '' : Number(event.target.value)) })}
          <Toggle label="Show Decimal Points" checked={form.padDecimals} onChange={(value) => update('padDecimals', value)} />
        </> : null}
        {form.widget === 'result_widget' ? <FormElement type="text" label="Default Value" inputProps={{ value: form.defaultValue, placeholder: 'Default value', onChange: (event) => update('defaultValue', event.target.value) }}
          helperText={<small className="text-muted">Use &quot;-&quot; to keep this default as blank / null.</small>} /> : null}
        {form.widget === 'text_widget' ? <Toggle label="Editable" checked={form.editable} onChange={(value) => update('editable', value)} /> : null}
        {form.widget === 'formula_widget' ? <>{input('formula', 'Formula', 'textarea')}{input('displayScale', 'Decimal Points', 'text', { type: 'number', min: 0, max: 100, onChange: (event) => update('displayScale', event.target.value === '' ? '' : Number(event.target.value)) })}<Toggle label="Show Decimal Points" checked={form.padDecimals} onChange={(value) => update('padDecimals', value)} />
          <FormElement type="dropdown" label="On Missing Input" inputProps={{ value: form.formulaOnMissingValue, options: [{ value: 'zero', label: 'Treat as zero' }, { value: 'blank', label: 'Leave blank' }, { value: 'error', label: 'Show an error' }], onChange: (event) => update('formulaOnMissingValue', event.target.value) }} />
          <FormElement type="dropdown" label="On Calculation Error" inputProps={{ value: form.formulaOnError, options: [{ value: 'show_error', label: 'Show the error' }, { value: 'blank', label: 'Leave blank' }], onChange: (event) => update('formulaOnError', event.target.value) }} />
        </> : null}
        {form.widget === 'dropdown_widget' ? <FormElement type="text" label="Comma Separated Options" inputProps={{ value: form.options.join(','), onChange: (event) => update('options', event.target.value.split(',').map((value) => value.trim())) }} /> : null}
      </div></section>
      <section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Access</h3><p>Leave a list empty to allow every role. Restricting edit or view access is enforced on the server, not just hidden in this UI.</p></div><div className="template-designer-form-grid template-designer-form-grid--single">
        <FormElement type="searchable-select" label="Who Can Edit?" inputProps={{ multiple: true, value: form.editRoleIds, options: roleOptions.map((role) => ({ value: role.id, label: role.name })), placeholder: 'Every role', onChange: (values) => update('editRoleIds', values) }} />
        <FormElement type="searchable-select" label="Who Can View?" inputProps={{ multiple: true, value: form.viewRoleIds, options: roleOptions.map((role) => ({ value: role.id, label: role.name })), placeholder: 'Every role', onChange: (values) => update('viewRoleIds', values) }} />
      </div></section>
    </> : panel.type === 'column' ? <><section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Layout</h3><p>Control the widget type, display class, and column ordering.</p></div><div className="template-designer-form-grid">
      <FormElement type="dropdown" label="Index" inputProps={{ value: form.indexValue, options: [{ value: '', label: 'Select index' }, ...Array.from({ length: 12 }, (_, index) => ({ value: String(-(index + 1)), label: String(index + 1) }))], onChange: (event) => update('indexValue', event.target.value) }} />
      <FormElement type="searchable-select" label="Widget" inputProps={{ value: form.widget, options: widgetOptions.filter((option) => ['report', 'datasheet'].includes(model.version.kind) || !isContextWidget(option.value)), placeholder: 'Select widget', onChange: (value) => update('widget', value) }} />
      {input('cssClass', 'Class', 'text', { placeholder: 'e.g. col-6 border border-bottom text-center' })}
      <FormElement type="dropdown" label="Master" inputProps={{ value: form.masterValue, options: [{ value: '', label: 'Select Master' }], onChange: (event) => update('masterValue', event.target.value) }} />
    </div></section><section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Access</h3><p>Choose which roles can edit or view this column.</p></div><div className="template-designer-form-grid">
      <FormElement type="searchable-select" label="Who Can Edit?" inputProps={{ multiple: true, value: form.editRoleIds, options: roleOptions.map((role) => ({ value: role.id, label: role.name })), placeholder: 'Select edit roles', onChange: (values) => update('editRoleIds', values) }} />
      <FormElement type="searchable-select" label="Who Can View?" inputProps={{ multiple: true, value: form.viewRoleIds, options: roleOptions.map((role) => ({ value: role.id, label: role.name })), placeholder: 'Select view roles', onChange: (values) => update('viewRoleIds', values) }} />
    </div></section><section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Display</h3><p>Set where this column appears in reports and templates.</p></div><div className="template-designer-toggle-grid">
      <Toggle label="Show in CoA" checked={form.showInCoa} onChange={(value) => update('showInCoa', value)} />
      <Toggle label="Show in Data Template" checked={form.showInTemplate} onChange={(value) => update('showInTemplate', value)} />
      <Toggle label="Is Final Result?" checked={form.isFinalResult} onChange={(value) => update('isFinalResult', value)} />
      <Toggle label="Show in NABL" checked={form.showInNabl} onChange={(value) => update('showInNabl', value)} />
      <Toggle label="Show in Non-NABL" checked={form.showInNonNabl} onChange={(value) => update('showInNonNabl', value)} />
    </div></section></> : <section className="template-designer-form-section"><div className="template-designer-form-grid">
      {[['visible', 'Visible in Template'], ['isHeader', 'Header'], ['isFooter', 'Footer'], ['isFinalResult', 'Final Result / Print in CoA']].map(([key, label]) => <div key={key} className="form-group mb-2"><label><input className="custom-control-input" type="checkbox" checked={Boolean(form[key])} onChange={(event) => update(key, event.target.checked)} />{label}</label></div>)}
      {input('name', 'Unique Name')}
      <Toggle label="Show in NABL report only" checked={form.showInNabl} onChange={(value) => { update('showInNabl', value); if (value) update('showInNonNabl', false); }} />
      <Toggle label="Show in Non-NABL report only" checked={form.showInNonNabl} onChange={(value) => { update('showInNonNabl', value); if (value) update('showInNabl', false); }} />
      {['report', 'datasheet'].includes(model.version.kind) ? <>{[['isParameterLoop', 'Parameter Loop'], ['isParameterLoopHeader', 'Parameter Loop Header']].map(([key, label]) => <Toggle key={key} label={label} checked={form[key]} onChange={(value) => update(key, value)} />)}</> : null}
    </div></section>}
  </form>;
}

// The persistent right-hand properties panel — PERN's Template Studio always shows this
// docked next to the canvas, driven by whichever container/row/column/widget is selected,
// rather than opening a separate modal or drawer per action.
function InspectorButton({ children, icon, danger = false, primary = false, ...properties }) {
  return <button type="button" className={`template-studio-inspector-button${primary ? ' is-primary' : ''}${danger ? ' is-danger' : ''}`} {...properties}><AppIcon name={icon} size={16} /><span>{children}</span></button>;
}

function MoveButtons({ horizontal, position, count, busy, onMove }) {
  return <div className="template-studio-move-buttons" aria-label={horizontal ? 'Move column' : 'Move row'}>
    <InspectorButton icon={horizontal ? 'arrow-left' : 'arrow-up'} disabled={busy || position <= 0} onClick={() => onMove(-1)}>{horizontal ? 'Move left' : 'Move up'}</InspectorButton>
    <InspectorButton icon={horizontal ? 'arrow-right' : 'arrow-down'} disabled={busy || position >= count - 1} onClick={() => onMove(1)}>{horizontal ? 'Move right' : 'Move down'}</InspectorButton>
  </div>;
}

function InspectorContent({ panel, model, onPanel, onEdit, onCommand, busy }) {
  if (panel.type === 'section') {
    const section = model.sectionsById[panel.id];
    return <>
      <div className="template-studio-inspector-group"><h3>Build</h3><InspectorButton primary icon="plus" disabled={busy} onClick={() => onCommand({ type: 'addRow', sectionId: section.id })}>Add row</InspectorButton><InspectorButton icon="settings" disabled={busy} onClick={() => onEdit({ type: 'sectionSettings', id: section.id })}>Container settings</InspectorButton></div>
      <div className="template-studio-inspector-group"><h3>Reuse</h3><InspectorButton icon="fa-copy" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'section', id: section.id })}>Duplicate container</InspectorButton><InspectorButton icon="fa-clipboard" disabled={busy} onClick={() => copySection({ versionId: model.version.id, sectionId: section.id, label: section.name || 'Container' })}>Copy to another template</InspectorButton></div>
      <div className="template-studio-inspector-group template-studio-inspector-group--danger"><InspectorButton danger icon="trash" disabled={busy} onClick={() => onCommand({ type: 'delete', kind: 'section', id: section.id })}>Delete container</InspectorButton></div>
    </>;
  }
  if (panel.type === 'row') {
    const row = model.rowsById[panel.id];
    const siblings = model.sectionsById[row.sectionId].rowIds;
    const position = siblings.indexOf(row.id);
    return <>
      <div className="template-studio-inspector-group"><h3>Columns</h3><InspectorButton primary icon="plus" disabled={busy || row.columnIds.length >= 12} onClick={() => onEdit({ type: 'rowLayout', id: row.id, addColumn: true })}>Add column</InspectorButton><InspectorButton icon="fa-table-columns" disabled={busy} onClick={() => onEdit({ type: 'rowLayout', id: row.id })}>Edit column layout</InspectorButton><InspectorButton icon="settings" disabled={busy} onClick={() => onEdit({ type: 'rowSettings', id: row.id })}>More row settings</InspectorButton></div>
      <div className="template-studio-inspector-group"><h3>Position</h3><MoveButtons position={position} count={siblings.length} busy={busy} onMove={(direction) => onCommand({ type: 'move', kind: 'row', id: row.id, direction })} /></div>
      <div className="template-studio-inspector-group"><h3>Reuse</h3><InspectorButton icon="fa-copy" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'row', id: row.id })}>Duplicate row</InspectorButton><InspectorButton icon="refresh" disabled={busy} onClick={() => onCommand({ type: 'repeatRow', id: row.id, enabled: !row.ownRepeatGroupId })}>{row.ownRepeatGroupId ? 'Disable cloneable row' : 'Make row cloneable'}</InspectorButton></div>
      <div className="template-studio-inspector-group template-studio-inspector-group--danger"><InspectorButton danger icon="trash" disabled={busy} onClick={() => onCommand({ type: 'delete', kind: 'row', id: row.id })}>Delete row</InspectorButton></div>
    </>;
  }
  const column = model.columnsById[panel.id];
  const field = column?.fieldId ? model.fieldsById[column.fieldId] : null;
  if (panel.type === 'column') {
    const siblings = model.rowsById[column.rowId].columnIds;
    const position = siblings.indexOf(column.id);
    const span = Math.max(1, Math.min(12, column.span || Math.floor(12 / siblings.length) || 1));
    return <>
      <div className="template-studio-inspector-summary"><span><small>Grid width</small><strong>{span}/12</strong></span><span><small>Content</small><strong>{field ? field.widget.replaceAll('_', ' ') : 'Empty'}</strong></span></div>
      <div className="template-studio-inspector-group"><h3>Content</h3><InspectorButton primary icon={field ? 'edit' : 'plus'} disabled={busy} onClick={() => onEdit({ type: field ? 'widget' : 'column', id: column.id })}>{field ? 'Configure field' : 'Add a field'}</InspectorButton><InspectorButton icon="settings" disabled={busy} onClick={() => onEdit({ type: 'column', id: column.id })}>Column settings</InspectorButton><InspectorButton icon="fa-layer-group" disabled={busy || Boolean(field)} onClick={() => onCommand({ type: 'addSection', parentColumnId: column.id })}>Nest a container</InspectorButton></div>
      <div className="template-studio-inspector-group"><h3>Position</h3><MoveButtons horizontal position={position} count={siblings.length} busy={busy} onMove={(direction) => onCommand({ type: 'move', kind: 'column', id: column.id, direction })} /></div>
      <div className="template-studio-inspector-group template-studio-inspector-group--danger"><InspectorButton danger icon="trash" disabled={busy} onClick={() => onCommand({ type: 'delete', kind: 'column', id: column.id })}>Delete column</InspectorButton></div>
    </>;
  }
  if (panel.type === 'widget' && field) return <>
    <div className="template-studio-inspector-summary template-studio-inspector-summary--single"><span><small>Field type</small><strong>{field.widget.replaceAll('_', ' ')}</strong></span></div>
    {field.alias ? <div className="template-studio-field-key"><small>Field key</small><code>{field.alias}</code></div> : null}
    <div className="template-studio-inspector-group"><h3>Field</h3><InspectorButton primary icon="edit" disabled={busy} onClick={() => onEdit({ type: 'widget', id: column.id })}>Configure field</InspectorButton><InspectorButton icon="settings" disabled={busy} onClick={() => onEdit({ type: 'column', id: column.id })}>Column settings</InspectorButton></div>
    <div className="template-studio-inspector-group template-studio-inspector-group--danger"><InspectorButton danger icon="trash" disabled={busy} onClick={async () => { if (await onCommand({ type: 'delete', kind: 'field', id: field.id })) onPanel({ type: 'column', id: column.id }); }}>Delete field</InspectorButton></div>
  </>;
  return null;
}

export function PropertiesDock({ panel, model, onPanel, onEdit, onClose, onCommand, busy }) {
  const section = panel?.type === 'section' || panel?.type === 'sectionSettings' ? model.sectionsById[panel.id] : null;
  const row = panel?.type === 'row' ? model.rowsById[panel.id] : null;
  const column = panel?.type === 'column' || panel?.type === 'widget' ? model.columnsById[panel.id] : null;
  const field = column?.fieldId ? model.fieldsById[column.fieldId] : null;
  const selectedType = section ? 'Container' : row ? 'Row' : panel?.type === 'widget' ? 'Field' : column ? 'Column' : '';
  const selectedLabel = section?.name || (row ? `Row ${model.sectionsById[row.sectionId]?.rowIds.indexOf(row.id) + 1}` : panel?.type === 'widget' ? field?.label || field?.alias || field?.widget?.replaceAll('_', ' ') || 'Field' : column ? `Column ${model.rowsById[column.rowId]?.columnIds.indexOf(column.id) + 1}` : '');
  const selectedIcon = section ? 'fa-layer-group' : row ? 'fa-bars' : panel?.type === 'widget' ? 'fa-pen-ruler' : 'fa-table-columns';
  return <aside className="template-studio-sidebar template-studio-sidebar--inspector" aria-label="Selected item properties">
    <div className="template-studio-sidebar__header">
      <div><p>Selected item</p><h2>Properties</h2></div>
      <button type="button" className="template-studio-panel-close" aria-label="Close properties" onClick={onClose}><AppIcon name="close" size={18} /></button>
    </div>
    {panel ? <div className="template-studio-inspector-title"><span><AppIcon name={selectedIcon} size={18} /></span><div><small>{selectedType}</small><h3>{selectedLabel}</h3></div></div> : null}
    <div className={panel ? 'template-studio-inspector-scroll' : 'template-studio-inspector-empty'}>
      {!panel ? <><span><AppIcon name="fa-pen-ruler" size={24} /></span><h3>Select something to edit</h3><p>Choose a container, row, column, or field from the canvas or outline.</p></>
        : <InspectorContent panel={panel} model={model} onPanel={onPanel} onEdit={onEdit} onCommand={onCommand} busy={busy} />}
    </div>
  </aside>;
}

function distributeGrid(count) {
  const base = Math.floor(12 / count);
  const remainder = 12 - (base * count);
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function nextColumnKey(columns) {
  const indexes = columns.map((column) => /^new-(\d+)$/.exec(column.key)?.[1]).filter((value) => value !== undefined).map(Number);
  return `new-${indexes.length ? Math.max(...indexes) + 1 : 0}`;
}

function RowLayoutEditor({ row, model, addColumn, onClose, onCommand, busy }) {
  const initial = row.columnIds.map((id) => model.columnsById[id]).map((column) => ({ key: column.id, id: column.id, name: column.name ?? '', gridSpan: column.span || 12, widthMm: column.widthMm ?? '' }));
  if (addColumn && initial.length < 12) {
    const spans = distributeGrid(initial.length + 1);
    initial.forEach((column, index) => { column.gridSpan = spans[index]; });
    initial.push({ key: nextColumnKey(initial), name: '', gridSpan: spans.at(-1), widthMm: '' });
  }
  const [columns, setColumns] = useState(initial);
  const [error, setError] = useState('');
  const total = columns.reduce((sum, column) => sum + Number(column.gridSpan || 0), 0);
  const update = (index, field, value) => setColumns((current) => current.map((column, columnIndex) => (columnIndex === index ? { ...column, [field]: value } : column)));
  function add() {
    if (columns.length >= 12) return;
    setColumns((current) => {
      const spans = distributeGrid(current.length + 1);
      return [...current.map((column, index) => ({ ...column, gridSpan: spans[index] })), { key: nextColumnKey(current), name: '', gridSpan: spans.at(-1), widthMm: '' }];
    });
  }
  async function submit(event) {
    event.preventDefault();
    if (total !== 12) { setError('Column spans must total exactly 12 grid units.'); return; }
    const saved = await onCommand({ type: 'configureRowLayout', id: row.id, columns: columns.map(({ id, name, gridSpan, widthMm }) => ({
      ...(id ? { id } : {}), name: name.trim() || null, gridSpan: Number(gridSpan), widthMm: widthMm === '' ? null : Number(widthMm),
    })) });
    if (saved) onClose();
  }
  return <form className="template-designer-form" onSubmit={submit}>
    <div className="template-designer-form-section__header"><p className="athena-eyebrow">Template row</p><h2>Column layout</h2><p>Use all 12 grid units. The entire layout is saved in one transaction.</p></div>
    <section className="template-designer-form-section"><div className={`alert ${total === 12 ? 'alert-success' : 'alert-warning'}`}>Grid usage: <strong>{total}/12</strong></div><div className="athena-repeater">
      {columns.map((column, index) => <div className="athena-repeater-row" key={column.key}><div className="athena-inline-grid">
        <label>Name<input className="form-control" value={column.name} onChange={(event) => update(index, 'name', event.target.value)} /></label>
        <label>Grid span<input className="form-control" required type="number" min="1" max="12" value={column.gridSpan} onChange={(event) => update(index, 'gridSpan', event.target.value)} /></label>
        <label>Print width (mm)<input className="form-control" type="number" min="0.001" max="1000" step="0.001" value={column.widthMm} onChange={(event) => update(index, 'widthMm', event.target.value)} /></label>
      </div>{!column.id ? <button type="button" className="smplfy-btn btn btn-outline-danger" onClick={() => setColumns((current) => current.filter((_, columnIndex) => columnIndex !== index))}>Remove</button> : null}</div>)}
    </div><button type="button" className="smplfy-btn btn btn-outline-primary mt-3" onClick={add} disabled={columns.length >= 12}>Add column</button></section>
    {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}<div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" onClick={onClose} disabled={busy}>Close</SecondaryButton><PrimaryButton type="submit" disabled={busy || total !== 12}>{busy ? 'Saving…' : 'Save layout'}</PrimaryButton></div>
  </form>;
}

function RowSettingsEditor({ row, onClose, onCommand, busy }) {
  const [value, setValue] = useState({ name: row.name ?? '', cssClass: row.cssClass ?? '', keepTogether: row.keepTogether ?? false });
  async function submit(event) {
    event.preventDefault();
    if (await onCommand({ type: 'configureRow', id: row.id, name: value.name.trim() || null, cssClass: value.cssClass.trim(), keepTogether: value.keepTogether })) onClose();
  }
  return <form className="template-designer-form" onSubmit={submit}><section className="template-designer-form-section"><div className="template-designer-form-grid">
    <label className="template-designer-form-field--wide">Name<input className="form-control" value={value.name} onChange={(event) => setValue((current) => ({ ...current, name: event.target.value }))} /></label>
    <label className="template-designer-form-field--wide">Class<input className="form-control" maxLength="500" placeholder="e.g. border-bottom align-items-center" value={value.cssClass} onChange={(event) => setValue((current) => ({ ...current, cssClass: event.target.value }))} /></label>
    <Toggle wide label="Keep together when printing" checked={value.keepTogether} onChange={(keepTogether) => setValue((current) => ({ ...current, keepTogether }))} />
  </div></section><div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" onClick={onClose} disabled={busy}>Close</SecondaryButton><PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</PrimaryButton></div></form>;
}

export function PropertiesEditorModal({ panel, model, onClose, onCommand, busy }) {
  const formId = useId();
  if (!panel) return null;
  const title = { widget: 'Configure field', column: 'Column Settings', sectionSettings: 'Container settings', rowLayout: 'Column layout', rowSettings: 'Row settings' }[panel.type] || 'Properties';
  const standard = !['rowLayout', 'rowSettings'].includes(panel.type);
  const actions = standard ? <div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" disabled={busy} onClick={onClose}>{panel.type === 'widget' ? 'Cancel' : 'Close'}</SecondaryButton><PrimaryButton type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : panel.type === 'widget' ? 'Save field' : 'Save'}</PrimaryButton></div> : null;
  return <Modal open title={title} subtitle={panel.type === 'widget' ? 'Choose a field type and define how it behaves.' : undefined} titleIcon={panel.type === 'widget' ? 'edit' : 'settings'} size={panel.type === 'column' ? 'xl' : 'lg'} className={`template-designer-modal template-designer-modal--${panel.type === 'column' ? 'column' : 'widget'}`} bodyClassName="template-designer-modal__body" actionsClassName="template-designer-modal__footer" actions={actions} onClose={busy ? () => {} : onClose}>
    {panel.type === 'rowLayout' ? <RowLayoutEditor key={`${panel.id}:${model.version.revision}`} row={model.rowsById[panel.id]} model={model} addColumn={panel.addColumn} onClose={onClose} onCommand={onCommand} busy={busy} />
      : panel.type === 'rowSettings' ? <RowSettingsEditor key={`${panel.id}:${model.version.revision}`} row={model.rowsById[panel.id]} onClose={onClose} onCommand={onCommand} busy={busy} />
        : <SettingsForm key={`${panel.type}:${panel.id}:${model.version.revision}`} formId={formId} panel={panel} model={model} onCommand={onCommand} onSaved={onClose} busy={busy} />}
  </Modal>;
}

// Bulk column classes, matching the reference studio's "Add Classes" dialog.
export function BulkColumnClassesModal({ columnIds, onClose, onCommand, busy }) {
  const formId = useId();
  const [cssClass, setCssClass] = useState('');
  const [error, setError] = useState('');
  if (!columnIds) return null;
  async function submit(event) {
    event.preventDefault();
    if (!cssClass.trim()) { setError('Add at least one class.'); return; }
    if (!columnIds.length) { setError('Select at least one column.'); return; }
    setError('');
    if (await onCommand({ type: 'bulkConfigureColumns', ids: columnIds, cssClass: cssClass.trim() })) { setCssClass(''); onClose(); }
  }
  return <Modal open title="Add Classes" subtitle={`${columnIds.length} column${columnIds.length === 1 ? '' : 's'} selected`} titleIcon="settings" size="lg"
    className="template-designer-modal template-designer-modal--widget" bodyClassName="template-designer-modal__body" actionsClassName="template-designer-modal__footer"
    actions={<div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" disabled={busy} onClick={onClose}>Close</SecondaryButton><PrimaryButton type="submit" form={formId} disabled={busy}>{busy ? 'Saving…' : 'Apply Classes'}</PrimaryButton></div>}
    onClose={busy ? () => {} : onClose}>
    <form id={formId} onSubmit={submit} autoComplete="off" className="template-designer-form">
      <section className="template-designer-form-section">
        <FormElement type="text" label="Classes" inputProps={{ value: cssClass, placeholder: 'e.g. col-6 text-center', onChange: (event) => setCssClass(event.target.value) }}
          helperText={<small className="text-muted">Applied to every selected column.</small>} />
        {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      </section>
    </form>
  </Modal>;
}

export function TemplateDetailsModal({ model, onClose, onCommand, busy }) {
  const formId = useId();
  const [form, setForm] = useState({ type: 'editDetails', name: model.version.name, description: model.version.description });
  const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  async function submit(event) { event.preventDefault(); if (await onCommand(form)) onClose(); }
  return <Modal open title="Edit Master Template" titleIcon="settings" size="lg" onClose={busy ? () => {} : onClose}
    className="template-designer-modal template-designer-modal--widget" bodyClassName="template-designer-modal__body" actionsClassName="template-designer-modal__footer"
    actions={<div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" disabled={busy} onClick={onClose}>Close</SecondaryButton><PrimaryButton type="submit" form={formId} disabled={busy}>Save</PrimaryButton></div>}>
    <form id={formId} onSubmit={submit} autoComplete="off" className="template-designer-form">
      <section className="template-designer-form-section">
        <FormElement type="text" label="Name" inputProps={{ value: form.name, required: true, onChange: (event) => update('name', event.target.value) }} />
        <FormElement type="textarea" label="Description" inputProps={{ value: form.description, onChange: (event) => update('description', event.target.value) }} />
      </section>
    </form>
  </Modal>;
}
