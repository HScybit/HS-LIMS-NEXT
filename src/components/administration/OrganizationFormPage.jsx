'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { Skeleton } from '../ui/Skeleton.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';
import OrganizationSeedPanel from './OrganizationSeedPanel.jsx';
import { blankOrganizationForm, organizationToForm, organizationFormPayload, validateOrganizationForm } from '../../administration/organization-form-model.js';

const FORM_ID = 'organization-form';

function Field({ errors, label, mandatory = false, name, onChange, placeholder, type = 'text', value, ...inputProps }) {
  const error = errors[name];
  return <div className="smplfy-form-field">
    <div className="smplfy-form-label-row">
      <label className="smplfy-form-label form-label" htmlFor={name}>{label}</label>
      {mandatory ? <span className="smplfy-form-required">*</span> : null}
    </div>
    <input {...inputProps} id={name} name={name} type={type}
      className={`smplfy-form-control form-control${error ? ' is-invalid' : ''}${value ? '' : ' smplfy-form-empty'}`}
      value={value ?? ''} placeholder={placeholder} required={mandatory} aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? `${name}-message` : undefined}
      onChange={(event) => onChange(name, event.target.value)} />
    {error ? <div id={`${name}-message`} className="smplfy-form-feedback invalid-feedback">{error}</div> : null}
  </div>;
}

const Heading = ({ children }) => <div className="organization-form-heading">{children}</div>;

function FormSkeleton() {
  return <section className="organization-form organization-form-card" aria-label="Loading organization" role="status">
    <Skeleton width="190px" height={22} />
    <div className="row g-3 mt-1">{Array.from({ length: 10 }, (_, index) => (
      <div className={index === 8 ? 'col-12' : 'col-md-6'} key={index}><Skeleton width="100%" height={62} /></div>
    ))}</div>
  </section>;
}

export default function OrganizationFormPage({ organizationId = null }) {
  const editing = Boolean(organizationId);
  const router = useRouter();
  const [values, setValues] = useState(blankOrganizationForm());
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (!editing) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/administration/organizations/${organizationId}`, { signal: controller.signal })
      .then((organization) => { if (!controller.signal.aborted) { setValues(organizationToForm(organization)); setError(''); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [editing, organizationId]);

  function setField(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => { if (!current[name]) return current; const next = { ...current }; delete next[name]; return next; });
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const found = validateOrganizationForm(values, { editing });
    if (Object.keys(found).length) { setErrors(found); return; }
    setSaving(true); setError(''); setErrors({});
    try {
      const payload = organizationFormPayload(values, { editing });
      if (editing) {
        await apiRequest(`/api/administration/organizations/${organizationId}`, { method: 'PATCH', body: payload });
        showToast('Organization updated.');
        router.push('/administration/organizations');
      } else {
        setCreated(await apiRequest('/api/administration/organizations', { method: 'POST', body: payload }));
        showToast('Organization created.');
      }
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }

  if (created) {
    return <>
      <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center page-header__row">
        <div className="col page-header__start"><h1 className="page-title mb-0">Organization created</h1></div>
      </div></div></div></PageHeader>
      <main className="container-fluid px-0 p-4">
        <section className="organization-form organization-form-card">
          <div className="alert alert-success mb-3" role="status">
            Administrator username <strong>{created.admin.username}</strong>, temporary password <strong>{created.admin.temporaryPassword}</strong>.
            This password is shown only once — share it with the organization&rsquo;s administrator now.
          </div>
          <div className="d-flex gap-2">
            <PrimaryButton href="/administration/organizations">Back to Organizations</PrimaryButton>
            <SecondaryButton href={`/administration/organizations/${created.organizationId}/seed`}>Seed master data</SecondaryButton>
          </div>
        </section>
      </main>
    </>;
  }

  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start d-flex align-items-center gap-2">
        <SecondaryButton className="organization-form-back" href="/administration/organizations" aria-label="Back to organizations"><AppIcon name="chevron-left" /></SecondaryButton>
        <h1 className="page-title mb-0">{editing ? 'Edit Organization' : 'New Organization'}</h1>
      </div>
      <div className="col-auto page-header__actions">
        <PrimaryButton type="submit" form={FORM_ID} leftIcon="fa-floppy-disk" disabled={loading || saving}>
          {saving ? 'Saving...' : editing ? 'Update' : 'Save'}
        </PrimaryButton>
      </div>
    </div></div></div></PageHeader>

    <main className="container-fluid px-0 p-4">
      {loading ? <FormSkeleton /> : <>
        <form id={FORM_ID} className="organization-form" onSubmit={submit} noValidate>
          <section className="organization-form-card">
            {!editing ? <>
              <Heading>Organization Admin</Heading>
              <div className="row g-3 mb-4">
                <div className="col-md-6"><Field name="adminUsername" label="Organization Admin Username" value={values.adminUsername} errors={errors} onChange={setField}
                  placeholder="Enter admin username" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} mandatory /></div>
                <div className="col-md-6"><Field name="adminEmail" label="Admin Email" value={values.adminEmail} errors={errors} onChange={setField}
                  placeholder="Enter admin email" type="email" autoComplete="off" mandatory /></div>
                <div className="col-md-6"><Field name="adminDisplayName" label="Admin Name" value={values.adminDisplayName} errors={errors} onChange={setField}
                  placeholder="Enter admin name" mandatory /></div>
              </div>
            </> : null}

            <Heading>Organization Details</Heading>
            <div className="row g-3 mb-4">
              <div className="col-md-6"><Field name="name" label="Name" value={values.name} errors={errors} onChange={setField} placeholder="Add name of the organization" mandatory /></div>
              <div className="col-md-6"><Field name="domain" label="Domain" value={values.domain} errors={errors} onChange={setField} placeholder="Add domain of the organization" mandatory /></div>
              <div className="col-md-4"><div className="smplfy-form-field">
                <div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor="accountType">Account Type</label></div>
                <select id="accountType" name="accountType" className="smplfy-form-select form-select" value={values.accountType}
                  onChange={(event) => setField('accountType', event.target.value)}>
                  <option value="saas">SaaS</option><option value="enterprise">Enterprise</option>
                </select>
              </div></div>
              <div className="col-md-4"><Field name="activeFromDate" label="Active From" value={values.activeFromDate} errors={errors} onChange={setField} type="date" /></div>
              <div className="col-md-4"><Field name="activeTillDate" label="Active To" value={values.activeTillDate} errors={errors} onChange={setField} type="date" /></div>
              <div className="col-12"><div className="smplfy-checkbox-field smplfy-checkbox-field--inline">
                <input id="isActive" className="smplfy-checkbox smplfy-form-check-input form-check-input" type="checkbox"
                  checked={values.status === 'active'} onChange={(event) => setField('status', event.target.checked ? 'active' : 'suspended')} />
                <label className="smplfy-checkbox-field__label" htmlFor="isActive">Is Active</label>
              </div></div>
            </div>

            <Heading>Commercial Details</Heading>
            <div className="row g-3 mb-4">
              <div className="col-md-6"><Field name="purchaseOrderNumber" label="PO Number" value={values.purchaseOrderNumber} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="pricingPlan" label="Pricing Plan" value={values.pricingPlan} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="subscriptionCost" label="Subscription Cost" value={values.subscriptionCost} errors={errors} onChange={setField} inputMode="decimal" /></div>
              <div className="col-md-6"><Field name="customDevelopmentCost" label="Custom Dev Cost" value={values.customDevelopmentCost} errors={errors} onChange={setField} inputMode="decimal" /></div>
            </div>

            <Heading>Contact Details</Heading>
            <div className="row g-3">
              <div className="col-12"><Field name="address" label="Address" value={values.address} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="contactPerson" label="Contact Person" value={values.contactPerson} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="contactPhone" label="Contact Person Mobile" value={values.contactPhone} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="projectManager" label="Project Manager" value={values.projectManager} errors={errors} onChange={setField} /></div>
              <div className="col-md-6"><Field name="salesPerson" label="Sales Person" value={values.salesPerson} errors={errors} onChange={setField} /></div>
            </div>
            {error ? <div className="alert alert-danger mt-4 mb-0" role="alert">{error}</div> : null}
          </section>
        </form>
        {editing ? <section className="organization-form organization-form-card mt-4">
          <Heading>Seed Master Data</Heading>
          <OrganizationSeedPanel organizationId={organizationId} />
        </section> : null}
      </>}
    </main>
  </>;
}
