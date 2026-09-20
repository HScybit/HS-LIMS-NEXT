'use client';

import { useEffect, useState } from 'react';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { customFieldDateFormats, customFieldDateTimeFormats } from '../../masters/custom-field-config.js';
import { organizationDateFormatDefaults } from '../../organization-settings/date-formats.js';
import { sampleWorkflowTypes } from '../../organization-settings/sample-workflows.js';
import ModuleAccess from './ModuleAccess.jsx';
import { moduleAccessSettingsInput } from '../../organization-settings/module-access-input.js';
import { allocatedFieldKeys, sampleListingFieldKeys } from '../../organization-settings/access-lists.js';
import { templateDefaultPurposes, documentTypes } from '../../organization-settings/document-defaults.js';
import { projectTabKeys } from '../../organization-settings/settings-fields.js';
import LogoUpload from './LogoUpload.jsx';

const tabs = [
  { id: 'basic', label: 'Basic' }, { id: 'sample_page', label: 'Sample Page' }, { id: 'tr_settings', label: 'TR Settings' },
  { id: 'test_parameters_settings', label: 'Test Parameters Settings' }, { id: 'lab_settings', label: 'LAB Settings' },
  { id: 'template_configs', label: 'Template Configs' }, { id: 'workflow_configs', label: 'Workflow Configs' },
  { id: 'nabl_settings', label: 'NABL Settings' }, { id: 'accounting', label: 'Accounting' },
  { id: 'invoice', label: 'Proforma Invoice' }, { id: 'quotation', label: 'Quotation' }, { id: 'label', label: 'Label' },
  { id: 'sample-receipt', label: 'Sample Receipt' }, { id: 'sample-request', label: 'Sample Requests' },
  { id: 'settings', label: 'Tenant Settings' }, { id: 'permission', label: 'Access Control' },
];

const documentLabels = { proforma_invoice: 'Proforma Invoice', quotation: 'Quotation', label: 'Label', sample_receipt: 'Sample Receipt', sample_request: 'Sample Request' };
const templatePurposeLabels = { acknowledgement: 'Acknowledgement Receipt Template', result_page: 'Result Page Template',
  ilc_report: 'ILC Report Template (COA)', comparative_report: 'Comparative Report Template', intralab_report: 'Intralab Report Template' };
const allocatedFieldLabels = { disciplines: 'Disciplines', customer: 'Customer', retained: 'Retained', generate_url: 'Generate URL', blind: 'Blind', product: 'Product' };
const sampleListingFieldLabels = { customer: 'Customer', product: 'Product', created_date: 'Created Date', category: 'Category', status: 'Status', ulr_number: 'ULR Number' };
const projectTabLabels = { overview: 'Overview', stages: 'Stages', files: 'Files', update_history: 'Updates', workflow: 'Workflow', team: 'Team',
  requests: 'Requests', planner: 'Timeline', critical_params: 'Critical Params', project_metadata: 'Meta Data', project_rationale: 'Rationale', activity_log: 'Activity' };

function SettingsSelect({ id, label, value, options, disabled, onChange, helperText, placeholder = '— Select —' }) {
  const choices = options.filter(row => row.available !== false || row.id === value)
    .map((row) => ({ value: row.id, label: row.available === false ? `${row.label} (unavailable)` : row.label }));
  if (value && !choices.some((row) => row.value === value)) choices.unshift({ value, label: 'Unavailable selection', disabled: true });
  return <div className="col-md-6"><div className="mb-3"><FormElement type="dropdown" label={label} helperText={helperText}
    inputProps={{ id, name: id, value: value ?? '', placeholder, options: choices, disabled,
      onChange: (event) => onChange(event.target.value || null) }} /></div></div>;
}
function TextField({ id, label, value, disabled, onChange, placeholder, maxLength, size = 6, type = 'text', rows, helperText }) {
  return <div className={`col-md-${size}`}><div className="mb-3"><FormElement type={type === 'textarea' ? 'textarea' : 'text'} label={label} helperText={helperText}
    inputProps={{ id, type: type === 'textarea' ? undefined : type, value: value ?? '', placeholder, maxLength, rows, disabled,
      onChange: (event) => onChange(event.target.value) }} /></div></div>;
}
function IntField({ id, label, value, disabled, onChange, size = 6, helperText, allowClear = false }) {
  return <div className={`col-md-${size}`}><div className="mb-3"><FormElement label={label} helperText={helperText}
    inputProps={{ id, type: 'number', value: value ?? '', disabled,
      onChange: (event) => onChange(event.target.value === '' ? (allowClear ? null : 0) : Number(event.target.value)) }} /></div></div>;
}
function StaticSelect({ id, label, value, options, disabled, onChange, size = 6, placeholder }) {
  return <div className={`col-md-${size}`}><div className="mb-3"><FormElement type="dropdown" label={label}
    inputProps={{ id, value: value ?? '', placeholder, options, disabled, onChange: (event) => onChange(event.target.value || null) }} /></div></div>;
}
function CheckboxRow({ id, label, checked, disabled, onChange }) {
  return <div className="mb-3"><div className="smplfy-checkbox-field">
    <Checkbox id={id} ariaLabel={label} checked={Boolean(checked)} disabled={disabled} onChange={onChange} />
    <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor={id}>{label}</label></div>
  </div></div>;
}
function EnumMultiSelect({ id, label, value, keys, labels, disabled, onChange, size = 6, helperText }) {
  const options = keys.map((key) => ({ value: key, label: labels[key] }));
  return <div className={`col-md-${size}`}><div className="mb-3">
    <div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor={id}>{label}</label></div>
    <SearchableSelect id={id} multiple clearable disabled={disabled} options={options} value={value ?? []} onChange={(values) => onChange(values)} />
    {helperText ? <div className="smplfy-form-element__helper">{helperText}</div> : null}
  </div></div>;
}

function templateDefaultsGetter(draft) { return (purpose) => draft.templateDefaults.find((item) => item.purpose === purpose)?.templateId ?? null; }
function setTemplateDefault(setDraft, purpose, templateId) {
  setDraft((current) => ({ ...current, templateDefaults: [...current.templateDefaults.filter((item) => item.purpose !== purpose), ...(templateId ? [{ purpose, templateId }] : [])] }));
}
function emptyDocument(documentType) { return { documentType, numberScheme: null, numberPadding: null, headerTemplateId: null, headerHeightMm: null }; }
function documentGetter(draft, documentType) { return draft.documentSettings.find((item) => item.documentType === documentType) ?? emptyDocument(documentType); }
function updateDocument(setDraft, documentType, key, value) {
  setDraft((current) => {
    const exists = current.documentSettings.some((item) => item.documentType === documentType);
    const documentSettings = exists
      ? current.documentSettings.map((item) => item.documentType === documentType ? { ...item, [key]: value } : item)
      : [...current.documentSettings, { ...emptyDocument(documentType), [key]: value }];
    return { ...current, documentSettings };
  });
}

function DocumentPanel({ documentType, draft, setDraft, disabled, templates }) {
  const document = documentGetter(draft, documentType);
  const label = documentLabels[documentType];
  const update = (key, value) => updateDocument(setDraft, documentType, key, value);
  return <section className="settings-section"><h6 className="settings-section__title">{label} Settings</h6><div className="row gx-3">
    {documentType !== 'label' ? <TextField id={`${documentType}_number_scheme`} label={`${label} Scheme`} value={document.numberScheme}
      onChange={(value) => update('numberScheme', value || null)} disabled={disabled} maxLength={200} /> : null}
    {documentType !== 'label' ? <IntField id={`${documentType}_number_padding`} label={`${label} Number Padding`} value={document.numberPadding} allowClear
      onChange={(value) => update('numberPadding', value)} disabled={disabled} /> : null}
    <SettingsSelect id={`${documentType}_header_template`} label={`${label} Header`} value={document.headerTemplateId} options={templates} disabled={disabled} placeholder="— None —"
      onChange={(value) => update('headerTemplateId', value)} />
    <IntField id={`${documentType}_header_height`} label={`${label} Header Height`} value={document.headerHeightMm} allowClear
      onChange={(value) => update('headerHeightMm', value)} disabled={disabled} />
  </div></section>;
}

function ReminderTimesEditor({ value, disabled, onChange }) {
  const times = value.length ? value : [''];
  function update(index, next) { onChange(times.map((time, itemIndex) => itemIndex === index ? next : time)); }
  function remove(index) { const next = times.filter((_, itemIndex) => itemIndex !== index); onChange(next.length ? next : ['']); }
  return <div className="d-flex flex-column gap-2 align-items-start">
    {times.map((time, index) => <div className="d-flex align-items-center gap-2" key={index}>
      <input className="smplfy-form-control form-control" type="time" value={time} disabled={disabled} onChange={(event) => update(index, event.target.value)} />
      {!disabled ? <SecondaryButton type="button" size="small" tone="danger" onClick={() => remove(index)}>Remove</SecondaryButton> : null}
    </div>)}
    {!disabled ? <SecondaryButton type="button" size="small" leftIcon="plus" onClick={() => onChange([...times, ''])}>Add Time</SecondaryButton> : null}
  </div>;
}

export default function OrganizationSettings({ initialTab = 'template_configs' }) {
  const [activeTab, setActiveTab] = useState(initialTab); const [data, setData] = useState(null); const [draft, setDraft] = useState(null);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reminderEmailsText, setReminderEmailsText] = useState('');
  // This source checkbox is a local UI control; the source save command does not submit it.
  const [editNonNablStart, setEditNonNablStart] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await apiRequest('/api/organization-settings/laboratory', { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setDraft({ ...result.settings,
          schemeMonthFormat: result.settings.schemeMonthFormat || 'short',
          dateFormat: result.settings.dateFormat || organizationDateFormatDefaults.dateFormat,
          datetimeFormat: result.settings.datetimeFormat || organizationDateFormatDefaults.datetimeFormat }); setReminderEmailsText(result.settings.reminderEmails.join(', ')); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [reload]);
  async function save(event) {
    event.preventDefault(); if (saving || loading || !data.canManage) return;
    setSaving(true); setError('');
    try {
      const workflowId = draft.testRequestWorkflowId || draft.jobWorkflowId || null;
      const reminderEmails = reminderEmailsText.split(',').map((email) => email.trim()).filter(Boolean);
      const result = await apiRequest('/api/organization-settings/laboratory', { method: 'PUT', body: {
        revision: draft.revision, autoCreateJobs: draft.autoCreateJobs, selfAllocationEnabled: draft.selfAllocationEnabled, allowReceivingDateEdit: draft.allowReceivingDateEdit,
        resultSummaryTemplateId: draft.resultSummaryTemplateId, jobWorkflowId: workflowId, testRequestWorkflowId: workflowId,
        sampleWorkflows: draft.sampleWorkflows,
        moduleAccess: moduleAccessSettingsInput({ moduleAccess: draft.moduleAccess.map(({ moduleKey, enabled, roleIds, userIds }) => ({ moduleKey, enabled, roleIds, userIds })) }),
        schemeCurrentYearDigits: draft.schemeCurrentYearDigits ?? '', schemeNextYearDigits: draft.schemeNextYearDigits ?? '',
        schemeSeparator: draft.schemeSeparator ?? '', schemeMonthFormat: draft.schemeMonthFormat,
        schemeNonNablStartNumber: draft.schemeNonNablStartNumber ?? '', dateFormat: draft.dateFormat, datetimeFormat: draft.datetimeFormat,
        // Basic
        displayName: draft.displayName, description: draft.description, tagline: draft.tagline, brandColor: draft.brandColor,
        nablNumber: draft.nablNumber, locationCode: draft.locationCode, entityName: draft.entityName, productEntityName: draft.productEntityName,
        headerStyle: draft.headerStyle, templateAclEnabled: draft.templateAclEnabled, workflowBasedAcl: draft.workflowBasedAcl,
        workflowBasedTemplates: draft.workflowBasedTemplates, zebraPrintingEnabled: draft.zebraPrintingEnabled,
        // Sample Page
        scrollableSampleListing: draft.scrollableSampleListing, autoInitializeSamples: draft.autoInitializeSamples, showBarcodeSection: draft.showBarcodeSection,
        showJobcardActions: draft.showJobcardActions, showDatasheetActions: draft.showDatasheetActions, showWorkflowNodes: draft.showWorkflowNodes,
        useTemplatizedAcknowledgement: draft.useTemplatizedAcknowledgement, directlyPrintCoa: draft.directlyPrintCoa, allowManualResults: draft.allowManualResults,
        nonLimsMode: draft.nonLimsMode, limsLabel: draft.limsLabel, sampleAssociationMode: draft.sampleAssociationMode, defaultSampleCategoryId: draft.defaultSampleCategoryId,
        customTableRoleIds: draft.customTableRoleIds,
        // TR Settings
        sampleNumberScheme: draft.sampleNumberScheme, testRequestNumberScheme: draft.testRequestNumberScheme, jobNumberScheme: draft.jobNumberScheme,
        sampleNumberStart: draft.sampleNumberStart, testRequestNumberStart: draft.testRequestNumberStart,
        instrumentBreakdownValidationEnabled: draft.instrumentBreakdownValidationEnabled, minimumMaterialValidationEnabled: draft.minimumMaterialValidationEnabled,
        // Test Parameters Settings
        measurementUncertaintyEnabled: draft.measurementUncertaintyEnabled,
        // Lab Settings
        reminderTimes: draft.reminderTimes, reminderEmails, reminderBeforeMinutes: draft.reminderBeforeMinutes,
        // Template Configs
        templateDefaults: draft.templateDefaults,
        // NABL Settings
        printNablOnNonNabl: draft.printNablOnNonNabl, onDemandUlr: draft.onDemandUlr, generateUlrForAmendment: draft.generateUlrForAmendment,
        ulrStartNumber: draft.ulrStartNumber, includeFInUlr: draft.includeFInUlr, ulrNumberPadding: draft.ulrNumberPadding, retentionDays: draft.retentionDays,
        // Accounting
        companyLegalName: draft.companyLegalName, companyIdentificationNumber: draft.companyIdentificationNumber,
        companyTaxIdentifier: draft.companyTaxIdentifier, companyAddress: draft.companyAddress,
        // Document settings (Proforma Invoice/Quotation/Label/Sample Receipt/Sample Request)
        documentSettings: draft.documentSettings,
        // Tenant Settings
        defaultRetentionPeriod: draft.defaultRetentionPeriod, defaultClassification: draft.defaultClassification,
        productLabel: draft.productLabel, sampleLabel: draft.sampleLabel, customerLabel: draft.customerLabel, vendorLabel: draft.vendorLabel,
        sampleScheme: draft.sampleScheme, minimumPasswordLength: draft.minimumPasswordLength, maximumLoginAttempts: draft.maximumLoginAttempts,
        supportSlug: draft.supportSlug, operatingStartTime: draft.operatingStartTime, operatingEndTime: draft.operatingEndTime,
        environmentDataIntervalMinutes: draft.environmentDataIntervalMinutes, projectDefaultPage: draft.projectDefaultPage, projectTabs: draft.projectTabs,
        // Access Control
        allocatedFields: draft.allocatedFields, sampleListingFields: draft.sampleListingFields } });
      setDraft((current) => ({ ...current, revision: result.revision, testRequestWorkflowId: workflowId, jobWorkflowId: workflowId })); showToast('Settings saved successfully.');
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  const retry = <button type="button" className="btn btn-link" disabled={saving || loading} onClick={() => { setLoading(true); setReload((value) => value + 1); }}>Reload settings</button>;
  if (!data) return error ? <div className="alert alert-danger m-4" role="alert">{error}{retry}</div> : <AppLoader message="Loading organization settings..." />;
  const disabled = saving || loading || !data.canManage;
  const getTemplateDefault = templateDefaultsGetter(draft);
  return <div className="settings-layout">
    <nav className="settings-layout__rail" aria-label="Settings sections"><div className="settings-layout__rail-head">
      <div className="settings-layout__rail-label">Settings</div><h1 className="settings-layout__rail-title">Organization</h1>
    </div><div className="settings-layout__nav" role="tablist" aria-orientation="vertical">
      {tabs.map((tab) => <button key={tab.id} type="button" id={`tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id}
        aria-controls={`tabpanel-${tab.id}`} className={`settings-layout__tab ${activeTab === tab.id ? 'is-active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
    </div></nav>
    <form id="organization-settings-form" className="settings-layout__main settings-layout__form" onSubmit={save} aria-busy={loading}>
      <div className="settings-layout__surface"><div className="settings-layout__surface-header"><div>
        <h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2><p>All settings are saved together, so you can move between tabs before submitting.</p>
      </div>{data.canManage ? <div className="d-flex align-items-center gap-3"><PrimaryButton type="submit" disabled={saving || loading}>{saving ? 'Saving...' : 'Save Settings'}</PrimaryButton></div> : null}</div>
        <div className="settings-layout__surface-body">
          {error ? <div className="alert alert-danger" role="alert">{error}{retry}</div> : null}

          <div role="tabpanel" id="tabpanel-basic" aria-labelledby="tab-basic" hidden={activeTab !== 'basic'}>
            <section className="settings-section"><h6 className="settings-section__title">Company Logo</h6>
              <LogoUpload disabled={disabled} logo={data.logo} onUploaded={(logo) => setData((current) => ({ ...current, logo }))} />
            </section>
            <section className="settings-section"><h6 className="settings-section__title">Company Identity</h6><div className="row gx-3">
              <TextField id="display_name" label="Company Name" value={draft.displayName} placeholder="Acme Laboratories" maxLength={200} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, displayName: value || null }))} />
              <TextField id="nabl_number" label="NABL Registration Number" value={draft.nablNumber} placeholder="T-XXXXXX" maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, nablNumber: value || null }))} />
              <TextField id="location_code" label="Location Code" value={draft.locationCode} placeholder="0" maxLength={64} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, locationCode: value || null }))} />
              <TextField id="entity_name" label="Entity Name" value={draft.entityName} placeholder="Sample" maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, entityName: value }))} />
              <TextField id="product_entity_name" label="Project Request Entity Name" value={draft.productEntityName} placeholder="Project Request" maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, productEntityName: value }))} />
              <StaticSelect id="header_style" label="Header Style" value={draft.headerStyle} placeholder="— Select style —"
                options={[{ value: 'fixed', label: 'Fixed' }, { value: 'floating', label: 'Floating' }]} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, headerStyle: value }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Access &amp; Display Settings</h6>
              <CheckboxRow id="template_acl_enabled" label="Follow Access Control in Templates" checked={draft.templateAclEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, templateAclEnabled: value }))} />
              <CheckboxRow id="workflow_based_acl" label="Follow Workflow Based Access Control" checked={draft.workflowBasedAcl} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, workflowBasedAcl: value }))} />
              <CheckboxRow id="workflow_based_templates" label="Show Workflow Based Templates" checked={draft.workflowBasedTemplates} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, workflowBasedTemplates: value }))} />
              <CheckboxRow id="zebra_printing_enabled" label="Print Labels in Zebra Printer" checked={draft.zebraPrintingEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, zebraPrintingEnabled: value }))} />
            </section>
          </div>

          <div role="tabpanel" id="tabpanel-permission" aria-labelledby="tab-permission" hidden={activeTab !== 'permission'}>
            <ModuleAccess modules={draft.moduleAccess} disabled={disabled} onChange={moduleAccess => setDraft(current => ({ ...current, moduleAccess }))} />
            <section className="settings-section"><h6 className="settings-section__title">Field Configuration</h6><div className="row gx-3">
              <EnumMultiSelect id="allocated_fields" label="Allocated Fields" value={draft.allocatedFields} keys={allocatedFieldKeys} labels={allocatedFieldLabels}
                disabled={disabled} onChange={(value) => setDraft((current) => ({ ...current, allocatedFields: value }))} />
              <EnumMultiSelect id="sample_listing_fields" label="Sample Listing Page Fields" value={draft.sampleListingFields} keys={sampleListingFieldKeys} labels={sampleListingFieldLabels}
                disabled={disabled} onChange={(value) => setDraft((current) => ({ ...current, sampleListingFields: value }))} />
            </div></section>
          </div>

          <div role="tabpanel" id="tabpanel-sample_page" aria-labelledby="tab-sample_page" hidden={activeTab !== 'sample_page'}>
            <section className="settings-section"><h6 className="settings-section__title">Sample Listing Options</h6>
              {[
                ['scrollableSampleListing', 'scrollable_sample_listing', 'Make Sample Listing Scrollable'], ['autoInitializeSamples', 'auto_initialize_samples', 'Auto Initialize Samples'],
                ['showBarcodeSection', 'show_barcode_section', 'Show Barcode Section'], ['showJobcardActions', 'show_jobcard_actions', 'Show Job Card Button'],
                ['showDatasheetActions', 'show_datasheet_actions', 'Create Datasheet Manually'], ['showWorkflowNodes', 'show_workflow_nodes', 'Show Node-wise Templates'],
                ['useTemplatizedAcknowledgement', 'use_templatized_acknowledgement', 'Show Templatized Acknowledgement'], ['directlyPrintCoa', 'directly_print_coa', 'Directly Print COA'],
                ['allowManualResults', 'allow_manual_results', 'Add Results Manually'], ['allowReceivingDateEdit', 'allow_receiving_date_edit', 'Allow Editing Receiving Date'],
              ].map(([key, id, label]) => <CheckboxRow key={id} id={id} label={label} checked={draft[key]} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} />)}
              <div className="row g-3 align-items-end">
                <div className="col-md-4"><CheckboxRow id="non_lims_mode" label="Isn't LIMS?" checked={draft.nonLimsMode} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, nonLimsMode: value }))} /></div>
                <TextField id="lims_label" label="Project Label" value={draft.limsLabel} placeholder="Project" maxLength={100} size={8} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, limsLabel: value || null }))} />
              </div>
            </section>
            <section className="settings-section"><h6 className="settings-section__title">Templates &amp; Headers</h6><div className="row gx-3">
              <SettingsSelect id="acknowledgement_template" label="Acknowledgement Receipt Template" value={getTemplateDefault('acknowledgement')} options={data.templates} disabled={disabled}
                onChange={(value) => setTemplateDefault(setDraft, 'acknowledgement', value)} />
              <div className="col-md-6"><div className="mb-3">
                <div className="smplfy-form-element__label-row"><label className="smplfy-form-element__label" htmlFor="custom_table_roles">Show Custom Table To</label></div>
                <SearchableSelect id="custom_table_roles" multiple clearable disabled={disabled}
                  options={data.roleOptions.map((role) => ({ value: role.id, label: role.label }))} value={draft.customTableRoleIds}
                  onChange={(value) => setDraft((current) => ({ ...current, customTableRoleIds: value }))} />
                <div className="smplfy-form-element__helper">Select one or more roles.</div>
              </div></div>
              <SettingsSelect id="default_sample_category" label="Default Sample Category" value={draft.defaultSampleCategoryId} options={data.sampleCategoryOptions} disabled={disabled} placeholder="— None —"
                onChange={(value) => setDraft((current) => ({ ...current, defaultSampleCategoryId: value }))} />
              <SettingsSelect id="acknowledgement_header" label="Acknowledgement Receipt Header" value={documentGetter(draft, 'acknowledgement').headerTemplateId} options={data.templates} disabled={disabled} placeholder="— None —"
                onChange={(value) => updateDocument(setDraft, 'acknowledgement', 'headerTemplateId', value)} />
              <IntField id="acknowledgement_header_height" label="Acknowledgement Header Height" value={documentGetter(draft, 'acknowledgement').headerHeightMm} allowClear disabled={disabled}
                onChange={(value) => updateDocument(setDraft, 'acknowledgement', 'headerHeightMm', value)} />
            </div></section>
          </div>

          <div role="tabpanel" id="tabpanel-tr_settings" aria-labelledby="tab-tr_settings" hidden={activeTab !== 'tr_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">ID Schemes</h6><div className="row gx-3">
              <TextField id="sample_number_scheme" label="Sample ID Scheme" value={draft.sampleNumberScheme} maxLength={200} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, sampleNumberScheme: value }))} />
              <TextField id="test_request_number_scheme" label="TR ID Scheme" value={draft.testRequestNumberScheme} maxLength={200} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, testRequestNumberScheme: value }))} />
              <TextField id="job_number_scheme" label="Job ID Scheme" value={draft.jobNumberScheme} maxLength={200} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, jobNumberScheme: value }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Number Series</h6><div className="row gx-3">
              <IntField id="sample_number_start" label="Sample Number Start" value={draft.sampleNumberStart} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, sampleNumberStart: value }))} />
              <IntField id="test_request_number_start" label="TR Number Start" value={draft.testRequestNumberStart} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, testRequestNumberStart: value }))} />
            </div>
              <CheckboxRow id="auto_create_jobs" label="Auto Create Jobs" checked={draft.autoCreateJobs} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, autoCreateJobs: value }))} />
              <CheckboxRow id="enable_self_allocation" label="Enable Self Allocation" checked={draft.selfAllocationEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, selfAllocationEnabled: value }))} />
              <CheckboxRow id="instrument_breakdown_validation_enabled" label="Enable Instrument Breakdown Validation" checked={draft.instrumentBreakdownValidationEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, instrumentBreakdownValidationEnabled: value }))} />
              <CheckboxRow id="minimum_material_validation_enabled" label="Enable Minimum Material Validation" checked={draft.minimumMaterialValidationEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, minimumMaterialValidationEnabled: value }))} />
            </section>
          </div>

          <div role="tabpanel" id="tabpanel-test_parameters_settings" aria-labelledby="tab-test_parameters_settings" hidden={activeTab !== 'test_parameters_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">Measurement Settings</h6>
              <CheckboxRow id="measurement_uncertainty_enabled" label="Use Measurement of Uncertainty (MOU)" checked={draft.measurementUncertaintyEnabled} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, measurementUncertaintyEnabled: value }))} />
            </section>
          </div>

          <div role="tabpanel" id="tabpanel-lab_settings" aria-labelledby="tab-lab_settings" hidden={activeTab !== 'lab_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">Reminder Settings</h6>
              <div className="mb-3"><div className="smplfy-form-element__label-row mb-2"><span className="smplfy-form-element__label">Reminder Times</span></div>
                <ReminderTimesEditor value={draft.reminderTimes} disabled={disabled} onChange={(value) => setDraft((current) => ({ ...current, reminderTimes: value }))} /></div>
              <div className="row gx-3">
                <IntField id="reminder_before_minutes" label="Reminder Before (minutes)" value={draft.reminderBeforeMinutes} helperText="Enter 60 to send the reminder 1 hour before." disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, reminderBeforeMinutes: value }))} />
                <TextField id="reminder_emails" label="Reminder Email Addresses" type="textarea" rows={5} value={reminderEmailsText} size={12}
                  helperText="Comma-separated list of email addresses to notify." disabled={disabled} onChange={setReminderEmailsText} />
              </div>
            </section>
          </div>

          <div role="tabpanel" id="tabpanel-template_configs" aria-labelledby="tab-template_configs" hidden={activeTab !== 'template_configs'}>
            <section className="settings-section"><h6 className="settings-section__title">Report Templates</h6><div className="row gx-3">
              <SettingsSelect id="test_result_summary_template" label="Job Template" value={draft.resultSummaryTemplateId} options={data.templates} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, resultSummaryTemplateId: value }))} />
              {templateDefaultPurposes.filter((purpose) => purpose !== 'acknowledgement').map((purpose) => <SettingsSelect key={purpose} id={`template_${purpose}`} label={templatePurposeLabels[purpose]}
                value={getTemplateDefault(purpose)} options={data.templates} disabled={disabled} onChange={(value) => setTemplateDefault(setDraft, purpose, value)} />)}
            </div></section>
          </div>

          <div role="tabpanel" id="tabpanel-workflow_configs" aria-labelledby="tab-workflow_configs" hidden={activeTab !== 'workflow_configs'}>
            <section className="settings-section"><h6 className="settings-section__title">Sample Workflows</h6>
              {sampleWorkflowTypes.some(type => !draft.sampleWorkflows[type.key]) ? <div className="alert alert-warning mb-3">
                Workflow is not configured for: {sampleWorkflowTypes.filter(type => !draft.sampleWorkflows[type.key]).map(type => type.label).join(', ')}.
              </div> : null}
              <div className="row gx-3">{sampleWorkflowTypes.map(({ key, label }) => <SettingsSelect key={key} id={`sample_workflow_${key}`}
                label={label} value={draft.sampleWorkflows[key]} options={data.sampleWorkflowOptions} disabled={disabled} placeholder="— Select workflow —"
                helperText="Required before this sample type can be created."
                onChange={value => setDraft(current => ({ ...current, sampleWorkflows: { ...current.sampleWorkflows, [key]: value } }))} />)}</div>
            </section>
            <section className="settings-section"><h6 className="settings-section__title">Test Request Workflow</h6>
              {!draft.testRequestWorkflowId && !draft.jobWorkflowId ? <div className="alert alert-warning mb-3">Test Request / Job Workflow is not configured.</div> : null}
              {draft.testRequestWorkflowId && draft.jobWorkflowId && draft.testRequestWorkflowId !== draft.jobWorkflowId
                ? <div className="alert alert-warning mb-3">Test Requests and Jobs have different workflows. Saving applies the selected workflow to both.</div> : null}
              <div className="row gx-3">
              <SettingsSelect id="test_request_workflow" label="Test Request / Job Workflow" value={draft.testRequestWorkflowId || draft.jobWorkflowId} options={data.workflows} disabled={disabled}
                helperText="Used when dynamic Test Requests or Jobs are allocated."
                onChange={(value) => setDraft((current) => ({ ...current, testRequestWorkflowId: value, jobWorkflowId: value }))} />
            </div></section>
          </div>

          <div role="tabpanel" id="tabpanel-nabl_settings" aria-labelledby="tab-nabl_settings" hidden={activeTab !== 'nabl_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">NABL Configuration</h6>
              <CheckboxRow id="print_nabl_on_non_nabl" label="Print NABL Samples in Non-NABL CoA" checked={draft.printNablOnNonNabl} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, printNablOnNonNabl: value }))} />
              <CheckboxRow id="on_demand_ulr" label="Generate ULR on Demand" checked={draft.onDemandUlr} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, onDemandUlr: value }))} />
              <CheckboxRow id="generate_ulr_for_amendment" label="Generate ULR for Amendment Samples" checked={draft.generateUlrForAmendment} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, generateUlrForAmendment: value }))} />
              <div className="row gx-3">
                <IntField id="ulr_number_padding" label="ULR Number Padding" value={draft.ulrNumberPadding} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, ulrNumberPadding: value }))} />
                <IntField id="retention_days" label="Retention Days" value={draft.retentionDays} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, retentionDays: value }))} />
              </div>
            </section>
            <section className="settings-section"><h6 className="settings-section__title">ULR Number Series</h6><div className="row g-3 align-items-end">
              <IntField id="ulr_start_number" label="ULR Start Number" value={draft.ulrStartNumber} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, ulrStartNumber: value }))} />
              <div className="col-md-8"><FormElement label="Non-NABL Start Number" inputProps={{ id: 'non_nabl_start_number', type: 'number',
                value: draft.schemeNonNablStartNumber ?? '', disabled, onChange: (event) => setDraft((current) => ({ ...current, schemeNonNablStartNumber: event.target.value })) }} /></div>
              <div className="col-md-4"><div className="smplfy-checkbox-field"><Checkbox id="non_nabl_start_no" ariaLabel="Edit Start No.?" checked={editNonNablStart}
                disabled={disabled} onChange={setEditNonNablStart} /><div className="smplfy-checkbox-field__body">
                <label className="smplfy-checkbox-field__label mb-0" htmlFor="non_nabl_start_no">Edit Start No.?</label></div></div></div>
            </div>
              <CheckboxRow id="include_f_in_ulr" label={'Include "F" in ULR'} checked={draft.includeFInUlr} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, includeFInUlr: value }))} />
            </section>
          </div>

          <div role="tabpanel" id="tabpanel-accounting" aria-labelledby="tab-accounting" hidden={activeTab !== 'accounting'}>
            <section className="settings-section"><h6 className="settings-section__title">Legal &amp; Financial</h6><div className="row gx-3">
              <TextField id="company_legal_name" label="Company Legal Name" value={draft.companyLegalName} maxLength={250} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, companyLegalName: value || null }))} />
              <TextField id="company_tax_identifier" label="GST Number" value={draft.companyTaxIdentifier} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, companyTaxIdentifier: value || null }))} />
              <TextField id="company_identification_number" label="CIN" value={draft.companyIdentificationNumber} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, companyIdentificationNumber: value || null }))} />
              <TextField id="company_address" label="Registered Address" type="textarea" rows={3} size={12} value={draft.companyAddress} maxLength={4000} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, companyAddress: value || null }))} />
            </div></section>
          </div>

          {Object.keys(documentTypes).map((type) => <div role="tabpanel" id={`tabpanel-${type === 'proforma_invoice' ? 'invoice' : type.replaceAll('_', '-')}`}
            aria-labelledby={`tab-${type === 'proforma_invoice' ? 'invoice' : type.replaceAll('_', '-')}`} hidden={activeTab !== (type === 'proforma_invoice' ? 'invoice' : type.replaceAll('_', '-'))} key={type}>
            <DocumentPanel documentType={type} draft={draft} setDraft={setDraft} disabled={disabled} templates={data.templates} />
          </div>)}

          <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings" hidden={activeTab !== 'settings'}>
            <section className="settings-section"><h6 className="settings-section__title">Navigation &amp; Defaults</h6><div className="row gx-3">
              <StaticSelect id="sample_association_mode" label="Sample–Product Association" value={draft.sampleAssociationMode}
                options={[{ value: 'single', label: 'Single' }, { value: 'multiple', label: 'Multiple' }]} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, sampleAssociationMode: value || 'single' }))} />
              <StaticSelect id="project_default_page" label="Project Default Page" value={draft.projectDefaultPage} placeholder="— Select —"
                options={projectTabKeys.map((key) => ({ value: key, label: projectTabLabels[key] }))} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, projectDefaultPage: value }))} />
              <EnumMultiSelect id="project_tabs" label="Project Tabs" value={draft.projectTabs} keys={projectTabKeys} labels={projectTabLabels} size={12}
                disabled={disabled} onChange={(value) => setDraft((current) => ({ ...current, projectTabs: value }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Financial Year</h6><div className="row gx-3">
              {[
                ['schemeCurrentYearDigits', 'current_year_digits', 'Current Year Digits', 'e.g. 24', 128],
                ['schemeNextYearDigits', 'next_year_digits', 'Next Year Digits', 'e.g. 25', 128],
                ['schemeSeparator', 'separator', 'Separator', 'e.g. -', 250],
              ].map(([key, id, label, placeholder, maxLength]) => <div key={id} className="col-md-4"><div className="mb-3"><FormElement label={label}
                inputProps={{ id, value: draft[key] ?? '', placeholder, maxLength, disabled,
                  onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })) }} /></div></div>)}
              <div className="col-md-6"><FormElement type="dropdown" label="Current Month Format" inputProps={{ id: 'current_month_format', value: draft.schemeMonthFormat,
                options: [{ value: 'short', label: 'Short' }, { value: 'long', label: 'Long' }, { value: 'number', label: 'Number' }], disabled,
                onChange: (event) => setDraft((current) => ({ ...current, schemeMonthFormat: event.target.value })) }} /></div>
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Display &amp; Format</h6><div className="row gx-3">
              {[
                ['dateFormat', 'date_format', 'Date Format', customFieldDateFormats],
                ['datetimeFormat', 'datetime_format', 'Date-Time Format', customFieldDateTimeFormats],
              ].map(([key, id, label, formats]) => <div className="col-md-6" key={id}><div className="mb-3"><FormElement type="dropdown" label={label}
                inputProps={{ id, value: draft[key], disabled,
                  options: formats.some((option) => option.value === draft[key]) ? formats : [{ value: draft[key], label: draft[key] }, ...formats],
                  onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })) }} /></div></div>)}
              <IntField id="default_retention_period" label="Default Retention Period" value={draft.defaultRetentionPeriod} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, defaultRetentionPeriod: value }))} />
              <TextField id="default_classification" label="Default Classes" value={draft.defaultClassification} maxLength={150} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, defaultClassification: value || null }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Entity Labels</h6><div className="row gx-3">
              <TextField id="sample_label" label="Sample Label" value={draft.sampleLabel} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, sampleLabel: value }))} />
              <TextField id="product_label" label="Product Label" value={draft.productLabel} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, productLabel: value }))} />
              <TextField id="customer_label" label="Customer Label" value={draft.customerLabel} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, customerLabel: value }))} />
              <TextField id="vendor_label" label="Vendor Label" value={draft.vendorLabel} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, vendorLabel: value }))} />
              <TextField id="sample_scheme" label="Sample Scheme" value={draft.sampleScheme} maxLength={200} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, sampleScheme: value || null }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Security</h6><div className="row gx-3">
              <IntField id="minimum_password_length" label="Minimum Password Length" value={draft.minimumPasswordLength} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, minimumPasswordLength: value }))} />
              <IntField id="maximum_login_attempts" label="Maximum Login Attempts" value={draft.maximumLoginAttempts} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, maximumLoginAttempts: value }))} />
              <TextField id="support_slug" label="Support Slug" value={draft.supportSlug} maxLength={100} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, supportSlug: value || null }))} />
            </div></section>
            <section className="settings-section"><h6 className="settings-section__title">Operations</h6><div className="row gx-3">
              <div className="col-md-4"><div className="mb-3"><FormElement label="Operations Start Time" inputProps={{ id: 'operating_start_time', type: 'time',
                value: draft.operatingStartTime ?? '', disabled, onChange: (event) => setDraft((current) => ({ ...current, operatingStartTime: event.target.value || null })) }} /></div></div>
              <div className="col-md-4"><div className="mb-3"><FormElement label="Operations End Time" inputProps={{ id: 'operating_end_time', type: 'time',
                value: draft.operatingEndTime ?? '', disabled, onChange: (event) => setDraft((current) => ({ ...current, operatingEndTime: event.target.value || null })) }} /></div></div>
              <IntField id="environment_data_interval_minutes" label="Env Data Interval (minutes)" value={draft.environmentDataIntervalMinutes} allowClear size={4} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, environmentDataIntervalMinutes: value }))} />
            </div></section>
          </div>
        </div>
      </div>
    </form>
  </div>;
}
