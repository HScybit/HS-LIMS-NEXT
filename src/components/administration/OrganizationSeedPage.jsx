'use client';

import { useEffect, useState } from 'react';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import PageHeader from '../layout/PageHeader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import OrganizationSeedPanel from './OrganizationSeedPanel.jsx';

export default function OrganizationSeedPage({ organizationId }) {
  const [organization, setOrganization] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/api/administration/organizations/${organizationId}`, { signal: controller.signal })
      .then((loaded) => { if (!controller.signal.aborted) setOrganization(loaded); })
      .catch(() => {});
    return () => controller.abort();
  }, [organizationId]);

  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start d-flex align-items-center gap-2">
        <SecondaryButton className="organization-form-back" href="/administration/organizations" aria-label="Back to organizations"><AppIcon name="chevron-left" /></SecondaryButton>
        <div>
          <h1 className="page-title mb-0">Seed Master Data</h1>
          {organization ? <small className="text-secondary">{organization.name} · {organization.code}</small> : null}
        </div>
      </div>
      <div className="col-auto page-header__actions">
        <SecondaryButton href={`/administration/organizations/${organizationId}/edit`}>Edit organization</SecondaryButton>
      </div>
    </div></div></div></PageHeader>
    <main className="container-fluid px-0 p-4">
      <section className="organization-form organization-form-card">
        <OrganizationSeedPanel organizationId={organizationId} />
      </section>
    </main>
  </>;
}
