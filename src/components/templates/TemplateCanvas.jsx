'use client';

import { memo, useMemo, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { displayValue, valuePayload, capturedInputValue, valueKey } from '../../templates/calculations.js';
import { indexOccurrences } from '../../templates/occurrences.js';
import { assertCaptureSize } from '../../templates/runtime-limits.js';
import { contextWidgetPreview, contextWidgetValue, isContextWidget } from '../../templates/context-widgets.js';
import { qrCodeSvg } from '../../templates/qr-code.js';
import { fieldDefaultValue } from '../../templates/defaults.js';
import TemplateImageWidget from './TemplateImageWidget.jsx';
import TextWidget from './TextWidget.jsx';
import TrDataWidget from './TrDataWidget.jsx';
import ParameterDetailWidget from './ParameterDetailWidget.jsx';
import SampleLineWidget from './SampleLineWidget.jsx';
import { resolveParameterTitle, verticalTitleValue } from '../../templates/parameter-title.js';
import { createSerialNumberIndex } from '../../templates/serial-number.js';

const widgetTypeLabel = (widget) => (widget ? widget.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : '');
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const TemplateWidget = memo(function TemplateWidget({ field, mode = 'view', value, onChange, onCommit, onBeginEdit, onRefreshDetail, onCommand, captured = false, occurrenceId, validation, disabled = false, report, parameter, serialNumber, sectionId, imageSources, onUploadImage, showImagePlaceholder }) {
  const plan = mode === 'plan';
  const edit = mode === 'edit';
  const shown = displayValue(field, value);
  const label = field.alias || field.label || field.widget;
  if (field.widget === 'template_image_widget') return <TemplateImageWidget field={field} value={value} mode={mode} sources={imageSources} onUpload={onUploadImage} disabled={disabled} showPlaceholder={showImagePlaceholder} />;
  if (field.widget === 'parameter_detail_widget') return <ParameterDetailWidget field={field} mode={mode} value={value} captured={captured}
    parameter={parameter ?? report?.parameterDetailFallback} onRefresh={onRefreshDetail} occurrenceId={occurrenceId} disabled={disabled} />;
  if (field.widget === 'sample_line_item_data_widget') return <SampleLineWidget field={field} mode={mode} lineItem={report?.lineItem} onCommand={onCommand} disabled={disabled} />;
  if (field.widget === 'sno_widget') return <div data-ms-id={sectionId}>{contextWidgetValue(field, report, parameter, serialNumber)}</div>;
  if (field.widget === 'qr_code_widget') {
    const text = plan ? contextWidgetPreview.qr_code_widget : contextWidgetValue(field, report, parameter, serialNumber);
    const svg = qrCodeSvg(text);
    return <figure className="d-inline-flex flex-column align-items-center gap-1 mb-0">
      {svg ? <div style={{ width: '96px', height: '96px' }} aria-label={`QR code for ${text}`} dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="text-muted small">No value to encode</span>}
      {svg ? <figcaption className="small text-break text-center mb-0">{text}</figcaption> : null}
    </figure>;
  }
  if (field.widget === 'tr_data_widget') return <TrDataWidget field={field} mode={mode} report={report} parameter={parameter} />;
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
  return <TemplateCanvas model={model} mode="view" occurrences={capture.occurrences} values={values} dataContext={dataContext} sectionRoots={capture.sectionRoots} imageSources={report.assets?.templateImages} canvasId={null} idPrefix={`${report.report.id}-${parameter.id}-`} coaMode printMode variant={report.report.isNabl ? 'nabl' : 'non_nabl'} />;
}

function ReportResult({ report, parameter, serialNumber }) {
  return <div className="flex-grow-1 text-break">{(parameter ? [parameter] : report.results).map((result, index) => <div key={result.id} data-result-test-id={result.id}>
    {result.source === 'section' && report.finalCaptures?.[result.instanceId]
      ? <FrozenResultSections report={report} parameter={result} serialNumber={parameter ? serialNumber : index + 1} /> : String(result.finalResult ?? '')}
  </div>)}</div>;
}

// The markup/classes follow the source TemplateSectionNode, TemplateRowNode and TemplateColNode.
function TemplateColumn({ context, id, sectionId, isEditing, activeOccurrenceId, values, serialNumber }) {
  const { model, plan, mode, selected, onSelect, onCommand, onPanel, onEdit, bulk, busy, validation, onChange, onCommit, onBeginEdit, variant, coaMode, printMode } = context;
  const subject = context.runtime?.subjectFor(activeOccurrenceId);
  const parameter = subject ? { ...context.dataContext?.parametersByRequestId?.[subject.testRequestId], ...subject } : context.reportParameter;
  const column = model.columnsById[id];
  const field = model.fieldsById[column.fieldId];
  const hasChildren = column.childSectionIds.length > 0;
  const key = field ? valueKey(field.id, activeOccurrenceId) : null;
  if (!plan && validation[key]?.visible === false) return null;
  if (!plan && coaMode && column.showInCoa === false) return null;
  if (!plan && variant && column.showInNabl && !column.showInNonNabl && variant !== 'nabl') return null;
  if (!plan && variant && column.showInNonNabl && !column.showInNabl && variant !== 'non_nabl') return null;
  const widgetMode = isEditing ? 'plan' : plan ? 'view' : mode;
  const siblings = model.rowsById[column.rowId].columnIds;
  // A span of 0 means "auto" in the stored model, which the old Bootstrap `col`
  // class rendered as an equal share of the row.
  const span = Math.max(1, Math.min(12, column.span || Math.floor(12 / siblings.length) || 1));
  const position = siblings.indexOf(id) + 1;
  const choose = () => { onSelect?.(id); if (isEditing) onPanel?.({ type: 'column', id }); };
  return <div key={`${id}:${activeOccurrenceId ?? ''}`} className={`${column.cssClass || (column.span ? `col-${column.span}` : 'col')} col-add-widget widget-col template-studio-column border-dark ${hasChildren ? 'has-child p-0' : 'py-10 no-child'} ${isEditing && !field && !hasChildren ? 'is-empty-column' : ''} ${selected === id ? 'active is-studio-selected' : ''} ${column.showInNabl ? 'show_in_nabl' : ''} ${column.showInNonNabl ? 'show_in_non_nabl' : ''}`}
    style={{ '--studio-grid-span': span, ...(printMode && column.widthMm ? { width: `${column.widthMm}mm` } : {}), ...(column.heightMm ? { minHeight: `${column.heightMm}mm` } : {}) }}
    data-col-id={id} data-row-id={column.rowId} data-master-section-id={sectionId} data-field-id={field?.id} data-occurrence-id={activeOccurrenceId}
    data-show-in-coa={column.showInCoa} data-show-in-template={column.showInTemplate} data-show-in-nabl={column.showInNabl} data-show-in-non-nabl={column.showInNonNabl}
    onClick={(event) => { event.stopPropagation(); choose(); }}>
    {isEditing ? <div className="template-studio-column-bar action-row template-edit-toolbar template-edit-toolbar--column template-column-action-row">
      <div className="template-studio-column-label">
        {bulk.sectionId === sectionId ? <label className="template-studio-column-select" onClick={(event) => event.stopPropagation()}>
          <input type="checkbox" checked={bulk.columnIds.has(id)} onChange={() => bulk.toggleColumn(id)} />
          <span className="visually-hidden">Select column {position}</span>
        </label> : null}
        <button type="button" onClick={(event) => { event.stopPropagation(); choose(); }}><strong>Column {position}</strong><small>{span}/12</small></button>
      </div>
      <div className="template-studio-column-actions">
        <button type="button" className="template-studio-field-action" disabled={busy}
          onClick={(event) => { event.stopPropagation(); onSelect?.(id); onEdit?.({ type: field ? 'widget' : 'column', id }); }}>
          <AppIcon name={field ? 'edit' : 'fa-plus'} size={14} /><span>{field ? widgetTypeLabel(field.widget) : 'Add field'}</span>
        </button>
      </div>
    </div> : null}
    {isEditing && field?.widget !== 'text_widget' && !field?.alias ? <div className="template-column-warning"><AppIcon name="fa-exclamation-triangle" size={12} />Missing key</div> : null}
    <div className="row1">{isEditing && !field && !hasChildren ? <div className="template-studio-empty-column">
      <span><AppIcon name="fa-pen-ruler" size={20} /></span>
      <strong>This column is empty</strong>
      <small>Add a field users can view or complete.</small>
      <div>
        <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); onPanel({ type: 'column', id }); }}><AppIcon name="fa-plus" size={14} />Add field</button>
        <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); onCommand({ type: 'addSection', parentColumnId: id }); }}>Nest container</button>
      </div>
    </div> : null}{field ? <div className={isEditing ? 'template-designer-widget-preview' : undefined}
      onDoubleClick={isEditing ? (event) => { event.stopPropagation(); onPanel({ type: 'widget', id }); } : undefined}><TemplateWidget field={field} mode={widgetMode} value={values[key]} validation={validation[key]} onChange={onChange} onCommit={onCommit} onBeginEdit={onBeginEdit} occurrenceId={activeOccurrenceId} disabled={busy}
      onRefreshDetail={context.onRefreshDetail} onCommand={onCommand} captured={Boolean(context.runtime)}
      imageSources={context.imageSources ?? context.report?.assets?.templateImages ?? model.imageSources} onUploadImage={context.onUploadImage} showImagePlaceholder={context.showImagePlaceholder || plan}
      report={context.report ?? context.dataContext} parameter={parameter} sectionId={sectionId}
      serialNumber={field.widget === 'sno_widget' ? serialNumber : parameter?.serialNumber ?? context.reportSerialNumber ?? model.rowsById[column.rowId].serialNumber ?? 0} /></div> : null}
      {column.childSectionIds.map((childId) => renderSection(context, childId, activeOccurrenceId, values))}
    </div>
  </div>;
}

const TemplateRow = memo(function TemplateRow({ context, id, sectionId, isEditing, activeOccurrenceId, values, serialNumber }) {
  const { model, selected, onSelect, onPanel, busy, onCommand, mode, runtime, onRepeat } = context;
  const row = model.rowsById[id];
  const position = model.sectionsById[sectionId].rowIds.indexOf(id) + 1;
  const choose = () => { onSelect?.(id); if (isEditing) onPanel?.({ type: 'row', id }); };
  return <div key={`${id}:${activeOccurrenceId ?? ''}`} className={`widget-row m-0 align-items-center1 row flex-1 template-studio-row ${selected === id ? 'active is-studio-selected' : ''}`} style={row.keepTogether ? { breakInside: 'avoid', pageBreakInside: 'avoid' } : undefined} data-row-id={id} data-master-section-id={sectionId} data-occurrence-id={activeOccurrenceId} data-keep-together={row.keepTogether || undefined}
    onClick={(event) => { event.stopPropagation(); choose(); }}>
    {isEditing ? <div className="template-studio-node-bar template-studio-node-bar--row action-row template-edit-toolbar template-edit-toolbar--row template-row-action-row">
      <button type="button" className="template-studio-node-identity" onClick={(event) => { event.stopPropagation(); choose(); }}>
        <span className="template-studio-node-icon"><AppIcon name="fa-bars" size={15} /></span>
        <span><small>Row {position}</small><strong>{plural(row.columnIds.length, 'column')}</strong></span>
      </button>
      {row.ownRepeatGroupId ? <span className="template-studio-node-badge"><AppIcon name="fa-copy" size={12} />Cloneable</span> : null}
      <div className="template-studio-node-actions">
        <button className="template-studio-node-button is-primary" type="button" disabled={busy || row.columnIds.length >= 12} onClick={(event) => { event.stopPropagation(); onCommand({ type: 'addColumn', rowId: id }); }}><AppIcon name="fa-plus" size={14} />Column</button>
      </div>
    </div> : null}
    {row.columnIds.map((columnId) => <TemplateColumn key={columnId} context={context} id={columnId} sectionId={sectionId} isEditing={isEditing} activeOccurrenceId={activeOccurrenceId} values={values} serialNumber={serialNumber} />)}
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
    || previous.isEditing !== next.isEditing || previous.activeOccurrenceId !== next.activeOccurrenceId || previous.serialNumber !== next.serialNumber) return false;
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

function renderRow(context, id, sectionId, isEditing, parentOccurrenceId, values, serials) {
  const row = context.model.rowsById[id];
  const rows = context.runtime && row.ownRepeatGroupId ? context.runtime.forGroup(parentOccurrenceId, row.ownRepeatGroupId) : [{ id: parentOccurrenceId }];
  return rows.map(({ id: activeOccurrenceId }) => <TemplateRow key={`${id}:${activeOccurrenceId ?? ''}`} context={context} id={id} sectionId={sectionId}
    isEditing={isEditing} activeOccurrenceId={activeOccurrenceId} values={values} serialNumber={serials.get(id)?.get(activeOccurrenceId) ?? 0} />);
}

function renderSection(context, id, parentOccurrenceId, values, onlyOccurrenceId) {
  const { model, plan, runtime, selected, onSelect, busy, onPanel, onCommand, onBulkEdit, bulk } = context;
  const section = model.sectionsById[id];
  const isEditing = plan;
  if (!plan && section.visible === false) return null;
  const sections = runtime && section.ownRepeatGroupId ? runtime.forGroup(parentOccurrenceId, section.ownRepeatGroupId) : [{ id: parentOccurrenceId }];
  const reportContexts = !plan && !runtime && context.report && section.isParameterLoop && !context.reportParameter
    ? context.report.results.map((parameter, index) => ({ ...context, reportParameter: parameter, reportSerialNumber: index + 1 })) : [context];
  const serials = context.serialNumbers.forSection(id, parentOccurrenceId, context.reportParameter);
  const choose = () => { onSelect?.(id); if (plan) onPanel?.({ type: 'section', id }); };
  const columnIds = section.rowIds.flatMap((rowId) => model.rowsById[rowId].columnIds);
  return sections.filter((instance) => !onlyOccurrenceId || instance.id === onlyOccurrenceId).map(({ id: activeOccurrenceId }) => <div key={`${id}:${activeOccurrenceId ?? ''}`} id={`${context.idPrefix}${runtime || context.report && activeOccurrenceId ? `${id}-${activeOccurrenceId}` : id}`} data-section-id={id} data-occurrence-id={activeOccurrenceId} data-is-header={section.isHeader || undefined} data-is-footer={section.isFooter || undefined}
    data-is-param-loop={section.isParameterLoop || undefined} data-is-param-loop-header={section.isParameterLoopHeader || undefined}
    className={`master-section ${section.parentColumnId ? 'sub-section' : 'base-section'} ${section.cssClass} param_table template-studio-section ${selected === id ? 'active is-studio-selected' : ''} ${isEditing ? 'is-editing' : ''} ${section.showInNabl ? 'show_in_nabl' : ''} ${section.showInNonNabl ? 'show_in_non_nabl' : ''}`}
    onClick={(event) => { event.stopPropagation(); choose(); }}>
    {plan ? <div className="template-studio-node-bar template-studio-node-bar--section action-row template-edit-toolbar template-edit-toolbar--section">
      <button type="button" className="template-studio-node-identity" onClick={(event) => { event.stopPropagation(); choose(); }}>
        <span className="template-studio-node-icon"><AppIcon name="fa-layer-group" size={16} /></span>
        <span><small>{section.parentColumnId ? 'Nested container' : `Container ${model.rootSectionIds.indexOf(id) + 1}`}</small><strong>{section.name || 'Container'}</strong></span>
      </button>
      <div className="template-studio-node-meta">
        <span>{plural(columnIds.length, 'column')}</span>
        {section.isHeader ? <span>Header</span> : null}
        {section.isFooter ? <span>Footer</span> : null}
      </div>
      <div className="template-studio-node-actions">
        {bulk.sectionId === id ? <>
          <span className="template-studio-selection-count">{bulk.columnIds.size} selected</span>
          <button type="button" className="template-studio-node-button" disabled={!columnIds.length} onClick={(event) => { event.stopPropagation(); bulk.selectAll(columnIds); }}>{bulk.columnIds.size === columnIds.length ? 'Clear' : 'Select all'}</button>
          <button type="button" className="template-studio-node-button is-primary" disabled={!bulk.columnIds.size} onClick={(event) => { event.stopPropagation(); onBulkEdit?.([...bulk.columnIds]); }}>Edit selected</button>
          <button type="button" className="template-studio-node-button" onClick={(event) => { event.stopPropagation(); bulk.start(null); }}>Done</button>
        </> : <>
          <button type="button" className="template-studio-node-button" disabled={busy || !columnIds.length} onClick={(event) => { event.stopPropagation(); bulk.start(id); }}><AppIcon name="fa-check-double" size={14} />Bulk edit</button>
          <button type="button" className="template-studio-node-button is-primary" disabled={busy} onClick={(event) => { event.stopPropagation(); onCommand({ type: 'addRow', sectionId: id }); }}><AppIcon name="fa-plus" size={14} />Add row</button>
        </>}
      </div>
    </div> : null}
    {plan ? <div className="template-studio-section-content">
      {section.rowIds.map((rowId) => renderRow(context, rowId, id, isEditing, activeOccurrenceId, values, serials))}
      {section.rowIds.length ? null : <div className="template-studio-empty-row"><span>This container has no rows</span><button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); onCommand({ type: 'addRow', sectionId: id }); }}><AppIcon name="fa-plus" size={14} />Add row</button></div>}
    </div> : reportContexts.map((rowContext) => section.rowIds.map((rowId) => renderRow(rowContext, rowId, id, isEditing, rowContext.reportParameter?.id ?? activeOccurrenceId, values, serials)))}
  </div>);
}

export default function TemplateCanvas({ model, mode = 'plan', onCommand, onPanel, onEdit, onBulkEdit, selected, onSelect, busy = false, values = empty, occurrences, occurrenceId, validation = empty, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, report, dataContext, sectionRoots, canvasId = 'template-designer', idPrefix = '', onUploadImage, showImagePlaceholder = false, imageSources, variant, coaMode = false, printMode = false }) {
  const plan = mode === 'plan';
  const runtime = useMemo(() => {
    if (occurrences === undefined) return null;
    assertCaptureSize(model, occurrences);
    return indexOccurrences(model, occurrences);
  }, [model, occurrences]);
  const serialNumbers = useMemo(() => createSerialNumberIndex(model, runtime, plan ? undefined : report), [model, runtime, plan, report]);
  // Bulk column selection lives with the container that owns it, the way the
  // reference studio scopes it to one section at a time.
  const [bulkSectionId, setBulkSectionId] = useState(null);
  const [bulkColumnIds, setBulkColumnIds] = useState(() => new Set());
  const bulk = useMemo(() => ({
    sectionId: bulkSectionId,
    columnIds: bulkColumnIds,
    start: (sectionId) => { setBulkSectionId(sectionId); setBulkColumnIds(new Set()); },
    toggleColumn: (columnId) => setBulkColumnIds((current) => {
      const next = new Set(current);
      if (next.has(columnId)) next.delete(columnId); else next.add(columnId);
      return next;
    }),
    selectAll: (columnIds) => setBulkColumnIds((current) => (current.size === columnIds.length ? new Set() : new Set(columnIds))),
  }), [bulkSectionId, bulkColumnIds]);
  const context = useMemo(() => ({ model, mode, plan, onCommand, onPanel, onEdit, onBulkEdit, bulk, selected, onSelect, busy, validation, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, runtime, report, dataContext, idPrefix, onUploadImage, showImagePlaceholder, imageSources, serialNumbers, variant, coaMode, printMode }),
    [model, mode, plan, onCommand, onPanel, onEdit, onBulkEdit, bulk, selected, onSelect, busy, validation, onChange, onCommit, onBeginEdit, onRepeat, onRefreshDetail, runtime, report, dataContext, idPrefix, onUploadImage, showImagePlaceholder, imageSources, serialNumbers, variant, coaMode, printMode]);
  return <div id={canvasId ?? undefined} className="template-render-canvas">{sectionRoots
    ? sectionRoots.map((root) => renderSection(context, root.sectionId, root.parentOccurrenceId, values, root.occurrenceId))
    : model.rootSectionIds.map((id) => renderSection(context, id, runtime?.root.id ?? occurrenceId, values))}</div>;
}
