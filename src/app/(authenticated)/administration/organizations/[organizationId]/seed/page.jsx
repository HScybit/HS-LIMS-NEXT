import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import OrganizationSeedPage from '@/components/administration/OrganizationSeedPage.jsx';

export const metadata = { title: 'Seed Master Data' };
export default async function Page({ params }) {
  const { organizationId } = await params;
  const identity = await currentIdentity();
  if (!identity?.isPlatformAdministrator) return <div className="alert alert-warning m-4" role="alert">Platform administrator access is required.</div>;
  return <Suspense fallback={<AppLoader />}><OrganizationSeedPage organizationId={organizationId} /></Suspense>;
}
