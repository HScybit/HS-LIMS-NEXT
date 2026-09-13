'use client';

import { memo, useMemo } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import ActionButtonGroup from '../ui/ActionButtonGroup.jsx';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { displayValue, valuePayload, capturedInputValue, valueKey } from '../../templates/calculations.js';
import { indexOccurrences } from '../../templates/occurrences.js';
import { assertCaptureSize } from '../../templates/runtime-limits.js';
import { contextWidgetPreview, contextWidgetValue, isContextWidget } from '../../templates/context-widgets.js';
import { fieldDefaultValue } from '../../templates/defaults.js';
import TemplateImageWidget from './TemplateImageWidget.jsx';
import TextWidget from './TextWidget.jsx';
import ParameterDetailWidget from './ParameterDetailWidget.jsx';
import SampleLineWidget from './SampleLineWidget.jsx';
import { resolveParameterTitle, verticalTitleValue } from '../../templates/parameter-title.js';

export const TemplateWidget = memo(function TemplateWidget({ field, mode = 'view', value, onChange, onCommit, onBeginEdit, onRefreshDetail, onCommand, captured = false, occurrenceId, validation, disabled = false, report, parameter, serialNumber, imageSources, onUploadImage, showImagePlaceholder }) {
  const plan = mode === 'plan';
  const edit = mode === 'edit';
  const shown = displayValue(field, value);
  const label = field.alias || field.label || field.widget;
  if (field.widget === 'template_image_widget') return <TemplateImageWidget field={field} value={value} mode={mode} sources={imageSources} onUpload={onUploadImage} disabled={disabled} showPlaceholder={showImagePlaceholder} />;
  if (field.widget === 'parameter_detail_widget') return <ParameterDetailWidget field={field} mode={mode} value={value} captured={captured}
    parameter={parameter ?? report?.parameterDetailFallback} onRefresh={onRefreshDetail} occurrenceId={occurrenceId} disabled={disabled} />;
  if (field.widget === 'sample_line_item_data_widget') return <SampleLineWidget field={field} mode={mode} lineItem={report?.lineItem} onCommand={onCommand} disabled={disabled} />;
  if (!plan && field.widget === 'tr_result_widget' && report) return <ReportResult report={report} parameter={parameter} serialNumber={serialNumber} />;
  if (isContextWidget(field.widget)) return <div className={plan ? 'text-muted small' : 'text-break'}>{plan ? contextWidgetPreview[field.widget] : contextWidgetValue(field, report, parameter, serialNumber)}</div>;
  if (field.widget === 'text_widget') return <TextWidget field={field} mode={mode} value={value} parameter={parameter?.parameterTitleValues} occurrenceId={occurrenceId} disabled={disabled} onBeginEdit={onBeginEdit} onChange={onChange} onCommit={onCommit} />;
  if (field.widget === 'vertical_text_widget') return <div className="d-flex align-items-center justify-content-center h-100"><p className="text-center mb-0" style={{ transform: 'rotate(180deg)', writingMode: 'vertical-rl' }}>{verticalTitleValue(resolveParameterTitle(field.label, plan ? null : parameter?.parameterTitleValues))}</p></div>;
  if (field.widget === 'formula_widget') return plan ? <p className="text-break mb-0">{field.formula}</p> : <><div className={edit ? 'formulaWidgetInput' : undefined} aria-label={label}>{shown}</div>{value?.state === 'invalid' ? <div className="text-danger small" role="status">{value.errorMessage}</div> : null}</>;
  if (field.widget === 'checkbox_widget') return <Checkbox checked={Boolean(shown)} disabled={!edit || disabled} aria-label={label} onChange={edit ? (next) => { onChange?.(field.id, occurrenceId, next); onCommit?.(field.id, occurrenceId, next); } : undefined} />;
  if (!plan && !edit) return <div>{String(shown ?? '')}</div>;
  const inputProps = { 'aria-label': label, disabled: plan || disabled, placeholder: field.placeholder || (plan ? 'This is placeholder' : ''),
    value: edit ? (field.widget === 'result_widget' ? capturedInputValue(value) : valuePayload(value)) ?? '' : shown ?? '',
    onChange: edit ? (event) => onChange?.(field.id, occurrenceId, event.currentTarget.value) : undefined,
    onBlur: edit ? (event) => onCommit?.(field.id, occurrenceId, event.currentTarget.value) : undefined };
  let type = 'text';
  if (field.widget === 'paragraph_widget') type = 'textarea';
  if (field.widget === 'number_widget') { inputProps.type = 'number'; inputProps.step = 'any'; }
  if (field.widget === 'result_widget') {
    inputProps.className = 'result_widget form-control-solid task-input';
    if (!plan) inputProps.placeholder = fieldDefaultValue(field) !== null ? '' : field.placeholder || 'Enter value';
  }
  if (field.widget === 'datepicker_widget') inputProps.type = 'date';
  if (field.widget === 'dropdown_widget') {
    type = 'dropdown'; inputProps.value = value?.optionId ?? '';
    inputProps.options = field.options.map((option) => ({ value: option.id, label: option.label }));
    inputProps.onBlur = undefined;
    inputProps.onChange = edit ? (event) => { onChange?.(field.id, occurrenceId, event.target.value); onCommit?.(field.id, occurrenceId, event.target.value); } : undefined;
  }
  const hasResultDefault = edit && field.widget === 'result_widget' && fieldDefaultValue(field) !== null;
  const control = <FormElement type={type} className={hasResultDefault ? 'mb-0 w-100' : 'mb-0'} inputProps={inputProps} message={validation?.errors[0]?.message} messageTone="error" />;
  if (hasResultDefault) return <div className="input-group mb-0">{control}
    <small className="text-muted w-100" style={{ fontSize: '10px', marginTop: 2 }}>Default value · Enter &quot;-&quot; for blank</small>
  </div>;
  return control;
});

function MoveButton({ kind, id, direction, icon, label, onCommand, disabled }) {
  return <button type="button" className={`btn btn-sm ${kind === 'row' ? 'btn-secondary' : 'btn-warning'} template-edit-icon-button`} aria-label={label} title={label} disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onCommand({ type: 'move', kind, id, direction }); }}><AppIcon name={icon} /></button>;
}

const empty = Object.freeze({});

function FrozenResultSections({ report, parameter, serialNumber }) {
  const capture = report.finalCaptures[parameter.instanceId];
  const model = report.datasheetModels[capture.versionId];
  const values = useMemo(() => Object.fromEntries(capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value])), [capture.values]);
  // Context comes from this frozen report revision. A nested result widget
  // displays its scalar; it must not recursively expand the same sections.
  const dataContext = useMemo(() => {
    const result = { ...parameter, serialNumber };
    return { sample: report.sample, lineItem: capture.lineItem, results: [result], parametersByRequestId: { [parameter.testRequestId]: result },
      productDetailsByLineId: report.productDetailsByLineId, primaryProductLineId: report.primaryProductLineId, productLineId: parameter.sampleProductId };
  }, [report.sample, capture.lineItem, report.productDetailsByLineId, report.primaryProductLineId, parameter, serialNumber]);
  return <TemplateCanvas model={model} mode="view" occurrences={capture.occurrences} values={values} dataContext={dataContext} sectionRoots={capture.sectionRoots} imageSources={report.assets?.templateImages} canvasId={null} idPrefix={`${report.report.id}-${parameter.id}-`} />;
}

function ReportResult({ report, parameter, serialNumber }) {
  return <div className="flex-grow-1 text-break">{(parameter ? [parameter] : report.results).map((result, index) => <div key={result.id} data-result-test-id={result.id}>
    {result.source === 'section' && report.finalCaptures?.[result.instanceId]
      ? <FrozenResultSections report={report} parameter={result} serialNumber={parameter ? serialNumber : index + 1} /> : String(result.finalResult ?? '')}
  </div>)}</div>;
}

// The markup/classes follow the source TemplateSectionNode, TemplateRowNode and TemplateColNode.
function TemplateColumn({ context, id, sectionId, isEditing, activeOccurrenceId, values }) {
  const { model, plan, mode, selected, onSelect, onCommand, onPanel, busy, validation, onChange, onCommit, onBeginEdit } = context;
  const subject = context.runtime?.subjectFor(activeOccurrenceId);
  const parameter = subject ? { ...context.dataContext?.parametersByRequestId?.[subject.testRequestId], ...subject } : context.reportParameter;
  const column = model.columnsById[id];
  const field = model.fieldsById[column.fieldId];
  const hasChildren = column.childSectionIds.length > 0;
  const key = field ? valueKey(field.id, activeOccurrenceId) : null;
  if (!plan && validation[key]?.visible === false) return null;
  const widgetMode = isEditing ? 'plan' : plan ? 'view' : mode;
  return <div key={`${id}:${activeOccurrenceId ?? ''}`} className={`${column.cssClass || (column.span ? `col-${column.span}` : 'col')} col-add-widget widget-col border-dark ${hasChildren ? 'has-child p-0' : 'py-10 no-child'} ${selected === id ? 'active' : ''}`}
    data-col-id={id} data-row-id={column.rowId} data-master-section-id={sectionId} data-field-id={field?.id} data-occurrence-id={activeOccurrenceId} onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
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
    <div className="row1">{field ? <TemplateWidget field={field} mode={widgetMode} value={values[key]} validation={validation[key]} onChange={onChange} onCommit={onCommit} onBeginEdit={onBeginEdit} occurrenceId={activeOccurrenceId} disabled={busy}
      onRefreshDetail={context.onRefreshDetail} onCommand={onCommand} captured={Boolean(context.runtime)}
      imageSources={context.imageSources ?? context.report?.assets?.templateImages ?? model.imageSources} onUploadImage={context.onUploadImage} showImagePlaceholder={context.showImagePlaceholder || plan}
      report={context.report ?? context.dataContext} parameter={parameter} serialNumber={parameter?.serialNumber ?? context.reportSerialNumber ?? model.rowsById[column.rowId].serialNumber ?? 0} /> : null}
      {column.childSectionIds.map((childId) => renderSection(context, childId, activeOccurrenceId, values))}
    </div>
  </div>;
}

const TemplateRow = memo(function TemplateRow({ context, id, sectionId, isEditing, activeOccurrenceId, values }) {
  const { model, selected, onSelect, onPanel, busy, onCommand, mode, runtime, onRepeat } = context;
  const row = model.rowsById[id];
  return <div key={`${id}:${activeOccurrenceId ?? ''}`} className={`widget-row m-0 align-items-center1 row flex-1 ${selected === id ? 'active' : ''}`} data-row-id={id} data-master-section-id={sectionId} data-occurrence-id={activeOccurrenceId}
    onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
    {isEditing ? <div className="action-row template-edit-toolbar template-edit-toolbar--row template-row-action-row"><div className="template-edit-toolbar__content">
      <div className="template-edit-toolbar__cluster template-edit-toolbar__cluster--wide" role="group"><div className="template-edit-toolbar__cluster">
        <button className="btn mb-1 btn-light-danger text-danger row-offcanvas btn-sm template-edit-button" type="button" disabled={busy} onClick={() => onPanel({ type: 'row', id })}><AppIcon name="fa-cogs" className="me-2" /> Row</button>
        <button className="btn mb-1 btn-light-primary text-primary btn-sm template-edit-button template-edit-button--soft" type="button" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'row', id })}><AppIcon name="fa-clone" className="me-2" /> Clone</button>
      </div>{row.ownRepeatGroupId ? <span className="btn mb-1 btn-light-info text-primary btn-sm template-edit-button template-edit-button--soft"><AppIcon name="fa-copy" className="me-2" /> Cloneable</span> : null}</div>
      <div className="template-edit-move-controls" aria-label="Move row"><MoveButton kind="row" id={id} direction={-1} icon="fa-arrow-up" label="Move row up" onCommand={onCommand} disabled={busy} /><MoveButton kind="row" id={id} direction={1} icon="fa-arrow-down" label="Move row down" onCommand={onCommand} disabled={busy} /></div>
    </div></div> : null}
    {row.columnIds.map((columnId) => <TemplateColumn key={columnId} context={context} id={columnId} sectionId={sectionId} isEditing={isEditing} activeOccurrenceId={activeOccurrenceId} values={values} />)}
    {mode === 'edit' && runtime && row.ownRepeatGroupId && onRepeat ? <div className="row action-row p-0"><div className="col-12 p-0">
      {[
        { label: 'Delete row', icon: 'fa-trash', className: 'delete-row-btn btn-danger', type: 'remove' },
        { label: 'Clone row', icon: 'fa-plus', className: 'clone-row btn-primary', type: 'clone' },
        { label: 'Clone row with data', icon: 'fa-clone', className: 'clone-row-with-data btn-primary', type: 'clone', withData: true },
      ].map((action) => <a key={action.label} href="#" className={`btn btn-icon float-end delete-btn me-2 btn-xs ${action.className}`} aria-label={action.label} title={action.label} aria-disabled={busy}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onRepeat({ type: action.type, occurrenceId: activeOccurrenceId, ...(action.withData ? { withData: true } : {}) }); }}><AppIcon name={action.icon} /></a>)}
    </div></div> : null}
  </div>;
}, (previous, next) => {
  if (previous.context !== next.context || previous.id !== next.id || previous.sectionId !== next.sectionId
    || previous.isEditing !== next.isEditing || previous.activeOccurrenceId !== next.activeOccurrenceId) return false;
  if (previous.values === next.values) return true;
  const { model } = previous.context;
  return model.rowsById[previous.id].columnIds.every((id) => {
    const column = model.columnsById[id];
    // A container must deliver the changed map to its descendants. Leaf rows
    // only depend on their own field/occurrence values; all other props are in context.
    if (column.childSectionIds.length) return false;
    if (!column.fieldId) return true;
    const key = valueKey(column.fieldId, previous.activeOccurrenceId);
    return previous.values[key] === next.values[key];
  });
});

function renderRow(context, id, sectionId, isEditing, parentOccurrenceId, values) {
  const row = context.model.rowsById[id];
  const rows = context.runtime && row.ownRepeatGroupId ? context.runtime.forGroup(parentOccurrenceId, row.ownRepeatGroupId) : [{ id: parentOccurrenceId }];
  return rows.map(({ id: activeOccurrenceId }) => <TemplateRow key={`${id}:${activeOccurrenceId ?? ''}`} context={context} id={id} sectionId={sectionId}
    isEditing={isEditing} activeOccurrenceId={activeOccurrenceId} values={values} />);
}

function renderSection(context, id, parentOccurrenceId, values, onlyOccurrenceId) {
  const { model, plan, editing, runtime, selected, onSelect, busy, onPanel, onCommand, onToggleEdit } = context;
  const section = model.sectionsById[id];
  const isEditing = plan && Boolean(editing[id]);
  if (!plan && section.visible === false) return null;
  const sections = runtime && section.ownRepeatGroupId ? runtime.forGroup(parentOccurrenceId, section.ownRepeatGroupId) : [{ id: parentOccurrenceId }];
  const reportContexts = !plan && !runtime && context.report && section.isParameterLoop && !context.reportParameter
    ? context.report.results.map((parameter, index) => ({ ...context, reportParameter: parameter, reportSerialNumber: index + 1 })) : [context];
  return sections.filter((instance) => !onlyOccurrenceId || instance.id === onlyOccurrenceId).map(({ id: activeOccurrenceId }) => <div key={`${id}:${activeOccurrenceId ?? ''}`} id={`${context.idPrefix}${runtime || context.report && activeOccurrenceId ? `${id}-${activeOccurrenceId}` : id}`} data-section-id={id} data-occurrence-id={activeOccurrenceId} data-is-header={section.isHeader || undefined} data-is-footer={section.isFooter || undefined}
    data-is-param-loop={section.isParameterLoop || undefined} data-is-param-loop-header={section.isParameterLoopHeader || undefined}
    className={`master-section ${section.parentColumnId ? 'sub-section' : 'base-section'} ${section.cssClass} param_table ${selected === id ? 'active' : ''} ${isEditing ? 'is-editing' : ''}`}
    onClick={(event) => { event.stopPropagation(); onSelect?.(id); }}>
    {plan ? <div className="row action-row align-items-center template-edit-toolbar template-edit-toolbar--section"><div className="template-edit-toolbar__content">
      {isEditing ? <div className="template-edit-toolbar__cluster template-edit-toolbar__cluster--wide">
        <button type="button" className="btn mb-1 btn-light-info text-info container-offcanvas btn-sm template-edit-button" disabled={busy} onClick={() => onPanel({ type: 'section', id })}><AppIcon name="fa-cogs" className="me-2" /> Container</button>
        <button type="button" className="btn mb-1 btn-light-primary text-primary btn-sm template-edit-button template-edit-button--soft" disabled={busy} onClick={() => onCommand({ type: 'clone', kind: 'section', id })}><AppIcon name="fa-clone" className="me-2" /> Clone</button>
      </div> : null}<div className="template-edit-toolbar__spacer" />
      <button type="button" className={`btn mb-1 btn-sm template-edit-button ${isEditing ? 'btn-light-success text-success template-edit-button--active' : 'btn-light'}`} onClick={(event) => { event.stopPropagation(); onToggleEdit(id); }}><AppIcon name="fa-edit" className="me-2" />Edit Mode {isEditing ? 'On' : 'Off'}</button>
    </div></div> : null}
    {reportContexts.map((rowContext) => section.rowIds.map((rowId) => renderRow(rowContext, rowId, id, isEditing, rowContext.reportParameter?.id ?? activeOccurrenceId, values)))}
  </div>);
}

export default function TemplateCanvas({ model, mode = 'plan', editing = empty, onToggleEdit, onCommand, onPanel, selected, onSelect, busy = false, values = empty, occurrences, occurrenceId, validation = empty, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, report, dataContext, sectionRoots, canvasId = 'template-designer', idPrefix = '', onUploadImage, showImagePlaceholder = false, imageSources }) {
  const plan = mode === 'plan';
  const runtime = useMemo(() => {
    if (occurrences === undefined) return null;
    assertCaptureSize(model, occurrences);
    return indexOccurrences(model, occurrences);
  }, [model, occurrences]);
  const context = useMemo(() => ({ model, mode, plan, editing, onToggleEdit, onCommand, onPanel, selected, onSelect, busy, validation, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, runtime, report, dataContext, idPrefix, onUploadImage, showImagePlaceholder, imageSources }),
    [model, mode, plan, editing, onToggleEdit, onCommand, onPanel, selected, onSelect, busy, validation, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, runtime, report, dataContext, idPrefix, onUploadImage, showImagePlaceholder, imageSources]);
  return <div id={canvasId ?? undefined} className="template-render-canvas">{sectionRoots
    ? sectionRoots.map((root) => renderSection(context, root.sectionId, root.parentOccurrenceId, values, root.occurrenceId))
    : model.rootSectionIds.map((id) => renderSection(context, id, runtime?.root.id ?? occurrenceId, values))}</div>;
}
