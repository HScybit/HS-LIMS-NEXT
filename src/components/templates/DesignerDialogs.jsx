'use client';

import { useId, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import Offcanvas from '../ui/Offcanvas.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { widgetTypes } from '../../templates/input.js';
import { contextWidgetFields, isContextWidget } from '../../templates/context-widgets.js';

const widgetOptions = Object.keys(widgetTypes).map((value) => ({ value, label: value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()) })).sort((a, b) => a.label.localeCompare(b.label));

function Toggle({ label, checked, onChange }) {
  return <label className="template-designer-toggle-card"><input className="form-check-input" type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

export function DesignerModal({ panel, model, onClose, onCommand, busy }) {
  const formId = useId();
  const column = model.columnsById[panel.id];
  const field = model.fieldsById[column?.fieldId];
  const section = model.sectionsById[panel.id];
  const [form, setForm] = useState(() => {
    if (panel.type === 'widget') return { type: 'configureField', columnId: column.id, widget: field.widget, alias: field.alias, label: field.label, placeholder: field.placeholder, required: field.required, editable: field.editable,
      displayScale: field.numeric?.displayScale ?? '', padDecimals: field.numeric?.padDecimals ?? false, minimum: field.numeric?.minimum ?? '', maximum: field.numeric?.maximum ?? '',
      sourceField: field.sourceField ?? null, serialPadding: field.serialPadding ?? null,
      ...(field.widget === 'formula_widget' ? { formula: field.formula ?? '' } : {}), options: field.options.map((option) => option.value) };
    if (panel.type === 'column') return { type: 'configureColumn', id: column.id, span: column.span, cssClass: column.cssClass || 'col', widget: field?.widget || 'text_widget', isFinalResult: column.isFinalResult };
    if (panel.type === 'sectionSettings') return { type: 'configureSection', id: section.id, name: section.name, cssClass: section.cssClass, visible: section.visible, isHeader: section.isHeader, isFooter: section.isFooter, isFinalResult: section.isFinalResult, isParameterLoop: section.isParameterLoop, isParameterLoopHeader: section.isParameterLoopHeader };
    return { type: 'editDetails', name: model.version.name, description: model.version.description };
  });
  const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const title = { widget: 'Widget Configuration', column: 'Column Settings', sectionSettings: 'Container Settings', details: 'Edit Master Template' }[panel.type];
  async function submit(event) {
    event.preventDefault();
    if (await onCommand(form)) onClose();
  }
  function input(key, label, type = 'text', extra = {}) {
    return <FormElement key={key} type={type} label={label} inputProps={{ value: form[key] ?? '', onChange: (event) => update(key, event.target.value), ...extra }} />;
  }
  return <Modal open title={title} titleIcon={panel.type === 'widget' ? 'edit' : 'settings'} size={panel.type === 'column' ? 'xl' : 'lg'} onClose={busy ? () => {} : onClose}
    className={`template-designer-modal template-designer-modal--${panel.type === 'column' ? 'column' : 'widget'}`} bodyClassName="template-designer-modal__body" actionsClassName="template-designer-modal__footer"
    actions={<div className="template-designer-modal-actions"><SecondaryButton type="button" size="large" disabled={busy} onClick={onClose}>Close</SecondaryButton><PrimaryButton type="submit" form={formId} disabled={busy}>{panel.type === 'widget' ? 'Update data' : 'Save'}</PrimaryButton></div>}>
    <form id={formId} onSubmit={submit} autoComplete="off" className="template-designer-form">
      {panel.type === 'widget' ? <>
        <section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Behavior</h3><p>Configure the widget key and how this field behaves inside the template.</p></div><Toggle label="Required" checked={form.required} onChange={(value) => update('required', value)} /></section>
        <section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Fields</h3><p>Identifiers must be unique across the template.</p></div><div className="template-designer-form-grid template-designer-form-grid--single">
          {form.widget === 'text_widget' ? input('label', 'Title') : null}{input('alias', 'Key')}
          {isContextWidget(form.widget) && contextWidgetFields[form.widget].length ? <FormElement type="searchable-select" label={form.widget === 'sample_details_widget_v2' ? 'Sample Attribute' : 'Data Field'} inputProps={{ value: form.sourceField ?? '', options: contextWidgetFields[form.widget].map((value) => ({ value, label: value.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()) })), placeholder: 'Select field', onChange: (value) => update('sourceField', value || null) }} /> : null}
          {form.widget === 'sno_widget' ? input('serialPadding', '0 Padding', 'text', { type: 'number', min: 0, max: 100, onChange: (event) => update('serialPadding', event.target.value === '' ? null : Number(event.target.value)) }) : null}
          {['input_widget', 'number_widget', 'paragraph_widget'].includes(form.widget) ? input('placeholder', 'Placeholder') : null}
          {form.widget === 'text_widget' ? <Toggle label="Editable" checked={form.editable} onChange={(value) => update('editable', value)} /> : null}
          {form.widget === 'formula_widget' ? <>{input('formula', 'Formula', 'textarea')}{input('displayScale', 'Decimal Points', 'text', { type: 'number', min: 0, max: 100, onChange: (event) => update('displayScale', event.target.value === '' ? '' : Number(event.target.value)) })}<Toggle label="Show Decimal Points" checked={form.padDecimals} onChange={(value) => update('padDecimals', value)} /></> : null}
          {form.widget === 'dropdown_widget' ? <FormElement type="text" label="Comma Separated Options" inputProps={{ value: form.options.join(','), onChange: (event) => update('options', event.target.value.split(',').map((value) => value.trim())) }} /> : null}
        </div></section>
      </> : panel.type === 'column' ? <><section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Layout</h3><p>Control the widget type, display class, and column ordering.</p></div><div className="template-designer-form-grid">
        <FormElement type="searchable-select" label="Widget" inputProps={{ value: form.widget, options: widgetOptions.filter((option) => model.version.kind === 'report' || !isContextWidget(option.value)), placeholder: 'Select widget', onChange: (value) => update('widget', value) }} />
        {input('cssClass', 'Class', 'text', { placeholder: 'e.g. col-6 border border-bottom text-center' })}
      </div></section><section className="template-designer-form-section"><div className="template-designer-form-section__header"><h3>Display</h3><p>Set where this column appears in reports and templates.</p></div><div className="template-designer-toggle-grid"><Toggle label="Is Final Result?" checked={form.isFinalResult} onChange={(value) => update('isFinalResult', value)} /></div></section></> : panel.type === 'sectionSettings' ? <section className="template-designer-form-section"><div className="template-designer-form-grid">
        {[['isHeader', 'Header'], ['isFooter', 'Footer'], ['isFinalResult', 'Final Result / Print in CoA']].map(([key, label]) => <div key={key} className="form-group mb-2"><label><input className="custom-control-input" type="checkbox" checked={Boolean(form[key])} onChange={(event) => update(key, event.target.checked)} />{label}</label></div>)}
        {input('name', 'Unique Name')}
        {model.version.kind === 'report' ? <>{[['isParameterLoop', 'Parameter Loop'], ['isParameterLoopHeader', 'Parameter Loop Header']].map(([key, label]) => <Toggle key={key} label={label} checked={form[key]} onChange={(value) => update(key, value)} />)}</> : null}
      </div></section> : <section className="template-designer-form-section">{input('name', 'Name', 'text', { required: true })}{input('description', 'Description', 'textarea')}</section>}
    </form>
  </Modal>;
}

export function DesignerDrawer({ panel, model, onClose, onPanel, onCommand, busy }) {
  const drawer = useRef(null);
  const isRow = panel.type === 'row';
  const item = isRow ? model.rowsById[panel.id] : model.sectionsById[panel.id];
  const kind = isRow ? 'row' : 'section';
  function action(label, icon, command, className = '') {
    return <button key={label} type="button" disabled={busy} className={`btn ${isRow ? 'btn-light text-start template-row-config-action' : 'btn-icon template-container-config-action'} ${className}`} onClick={() => onCommand(command)}><AppIcon name={icon} className="me-2" />{label}</button>;
  }
  return <Offcanvas ref={drawer} title="Configuration" subtitle={isRow ? 'Template Row' : 'Template Container'} className={isRow ? 'template-row-config-panel' : 'template-container-config-panel'} onClose={onClose}>
    {item ? <div className={isRow ? 'template-row-config-actions' : 'template-container-config-actions'}>
      {isRow ? <section className="template-row-config-group"><div className="template-row-config-group__header"><span>Position</span><small>Move this row within the current container.</small></div><div className="template-row-config-action-row">
        {action('Move Up', 'fa-arrow-up', { type: 'move', kind, id: item.id, direction: -1 })}{action('Move Down', 'fa-arrow-down', { type: 'move', kind, id: item.id, direction: 1 })}
      </div></section> : <button type="button" disabled={busy} className="container-setting btn btn-icon btn-warning template-container-config-action" onClick={() => drawer.current.hide(() => onPanel({ type: 'sectionSettings', id: item.id }))}><AppIcon name="fa-cogs" className="me-2" />Configure</button>}
      {action(isRow ? 'Clone Row' : 'Clone Container', 'fa-clone', { type: 'clone', kind, id: item.id }, isRow ? 'btn-light-primary text-primary' : 'btn-primary')}
      {action(isRow ? 'Add New Column' : 'Add Row', 'fa-plus', isRow ? { type: 'addColumn', rowId: item.id } : { type: 'addRow', sectionId: item.id }, isRow ? 'btn-light-primary text-primary' : 'btn-success')}
      {isRow ? action(item.ownRepeatGroupId ? 'Disable Cloneable Row' : 'Make Cloneable', 'fa-copy', { type: 'repeatRow', id: item.id, enabled: !item.ownRepeatGroupId }, 'btn-light-info text-info') : null}
      {action(isRow ? 'Delete Row' : 'Delete Container', 'fa-trash', { type: 'delete', kind, id: item.id }, isRow ? 'btn-light-danger text-danger template-row-config-action--danger' : 'btn-danger template-container-config-action--danger')}
    </div> : <div className="alert alert-warning">Select an item to configure it.</div>}
  </Offcanvas>;
}
