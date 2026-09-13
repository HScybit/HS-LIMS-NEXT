'use client';

import { useEffect, useState } from 'react';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import FormElement from '../ui/FormElement.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';

const tabs = [{ id: 'tr_settings', label: 'TR Settings' }, { id: 'nabl_settings', label: 'NABL Settings' },
  { id: 'template_configs', label: 'Template Configs' }, { id: 'workflow_configs', label: 'Workflow Configs' }, { id: 'settings', label: 'Tenant Settings' }];

function SettingsSelect({ id, label, value, options, disabled, onChange, helperText }) {
  const choices = options.map((row) => ({ value: row.id, label: row.label }));
  if (value && !choices.some((row) => row.value === value)) choices.unshift({ value, label: 'Unavailable selection', disabled: true });
  return <div className="col-md-6"><div className="mb-3"><FormElement type="dropdown" label={label} helperText={helperText}
    inputProps={{ id, name: id, value: value ?? '', placeholder: '— Select —', options: choices, disabled,
      onChange: (event) => onChange(event.target.value || null) }} /></div></div>;
}

export default function OrganizationSettings({ initialTab = 'template_configs' }) {
  const [activeTab, setActiveTab] = useState(initialTab); const [data, setData] = useState(null); const [draft, setDraft] = useState(null);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const [reload, setReload] = useState(0);
  // This source checkbox is a local UI control; the source save command does not submit it.
  const [editNonNablStart, setEditNonNablStart] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await apiRequest('/api/organization-settings/laboratory', { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setDraft({ ...result.settings, schemeMonthFormat: result.settings.schemeMonthFormat || 'short' }); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [reload]);
  async function save(event) {
    event.preventDefault(); if (saving || !data.canManage) return;
    setSaving(true); setError('');
    try {
      const result = await apiRequest('/api/organization-settings/laboratory', { method: 'PUT', body: {
        revision: draft.revision, autoCreateJobs: draft.autoCreateJobs, selfAllocationEnabled: draft.selfAllocationEnabled,
        resultSummaryTemplateId: draft.resultSummaryTemplateId, jobWorkflowId: draft.jobWorkflowId,
        schemeCurrentYearDigits: draft.schemeCurrentYearDigits ?? '', schemeNextYearDigits: draft.schemeNextYearDigits ?? '',
        schemeSeparator: draft.schemeSeparator ?? '', schemeMonthFormat: draft.schemeMonthFormat,
        schemeNonNablStartNumber: draft.schemeNonNablStartNumber ?? '' } });
      setDraft((current) => ({ ...current, revision: result.revision })); showToast('Settings saved successfully.');
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  const retry = <button type="button" className="btn btn-link" disabled={saving} onClick={() => setReload((value) => value + 1)}>Reload settings</button>;
  if (!data) return error ? <div className="alert alert-danger m-4" role="alert">{error}{retry}</div> : <AppLoader message="Loading organization settings..." />;
  const disabled = saving || !data.canManage;
  return <div className="settings-layout">
    <nav className="settings-layout__rail" aria-label="Settings sections"><div className="settings-layout__rail-head">
      <div className="settings-layout__rail-label">Settings</div><h1 className="settings-layout__rail-title">Organization</h1>
    </div><div className="settings-layout__nav" role="tablist" aria-orientation="vertical">
      {tabs.map((tab) => <button key={tab.id} type="button" id={`tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id}
        aria-controls={`tabpanel-${tab.id}`} className={`settings-layout__tab ${activeTab === tab.id ? 'is-active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
    </div></nav>
    <form id="organization-settings-form" className="settings-layout__main settings-layout__form" onSubmit={save}>
      <div className="settings-layout__surface"><div className="settings-layout__surface-header"><div>
        <h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2><p>All settings are saved together, so you can move between tabs before submitting.</p>
      </div>{data.canManage ? <div className="d-flex align-items-center gap-3"><PrimaryButton type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</PrimaryButton></div> : null}</div>
        <div className="settings-layout__surface-body">
          {error ? <div className="alert alert-danger" role="alert">{error}{retry}</div> : null}
          <div role="tabpanel" id="tabpanel-tr_settings" aria-labelledby="tab-tr_settings" hidden={activeTab !== 'tr_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">Number Series</h6>
              <div className="mb-3"><div className="smplfy-checkbox-field">
                <Checkbox id="auto_create_jobs" ariaLabel="Auto Create Jobs" checked={draft.autoCreateJobs} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, autoCreateJobs: value }))} />
                <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="auto_create_jobs">Auto Create Jobs</label></div>
              </div></div>
              <div className="mb-3"><div className="smplfy-checkbox-field">
                <Checkbox id="enable_self_allocation" ariaLabel="Enable Self Allocation" checked={draft.selfAllocationEnabled} disabled={disabled}
                  onChange={(value) => setDraft((current) => ({ ...current, selfAllocationEnabled: value }))} />
                <div className="smplfy-checkbox-field__body"><label className="smplfy-checkbox-field__label mb-0" htmlFor="enable_self_allocation">Enable Self Allocation</label></div>
              </div></div>
            </section>
          </div>
          <div role="tabpanel" id="tabpanel-template_configs" aria-labelledby="tab-template_configs" hidden={activeTab !== 'template_configs'}>
            <section className="settings-section"><h6 className="settings-section__title">Report Templates</h6><div className="row gx-3">
              <SettingsSelect id="test_result_summary_template" label="Job Template" value={draft.resultSummaryTemplateId} options={data.templates} disabled={disabled}
                onChange={(value) => setDraft((current) => ({ ...current, resultSummaryTemplateId: value }))} />
            </div></section>
          </div>
          <div role="tabpanel" id="tabpanel-workflow_configs" aria-labelledby="tab-workflow_configs" hidden={activeTab !== 'workflow_configs'}>
            <section className="settings-section"><h6 className="settings-section__title">Test Request Workflow</h6><div className="row gx-3">
              <SettingsSelect id="job_workflow" label="Job Workflow" value={draft.jobWorkflowId} options={data.workflows} disabled={disabled}
                helperText="Used when jobs are allocated. Leave empty to use the sample category's test request workflow."
                onChange={(value) => setDraft((current) => ({ ...current, jobWorkflowId: value }))} />
            </div></section>
          </div>
          <div role="tabpanel" id="tabpanel-nabl_settings" aria-labelledby="tab-nabl_settings" hidden={activeTab !== 'nabl_settings'}>
            <section className="settings-section"><h6 className="settings-section__title">ULR Number Series</h6><div className="row g-3 align-items-end">
              <div className="col-md-8"><FormElement label="Non-NABL Start Number" inputProps={{ id: 'non_nabl_start_number', type: 'number',
                value: draft.schemeNonNablStartNumber ?? '', disabled, onChange: (event) => setDraft((current) => ({ ...current, schemeNonNablStartNumber: event.target.value })) }} /></div>
              <div className="col-md-4"><div className="smplfy-checkbox-field"><Checkbox id="non_nabl_start_no" ariaLabel="Edit Start No.?" checked={editNonNablStart}
                disabled={disabled} onChange={setEditNonNablStart} /><div className="smplfy-checkbox-field__body">
                <label className="smplfy-checkbox-field__label mb-0" htmlFor="non_nabl_start_no">Edit Start No.?</label></div></div></div>
            </div></section>
          </div>
          <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings" hidden={activeTab !== 'settings'}>
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
          </div>
        </div>
      </div>
    </form>
  </div>;
}
