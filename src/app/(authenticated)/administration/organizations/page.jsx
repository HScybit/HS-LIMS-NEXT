import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import OrganizationsListPage from '@/components/administration/OrganizationsListPage.jsx';

export const metadata = { title: 'Organizations' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.isPlatformAdministrator) return <div className="alert alert-warning m-4" role="alert">Platform administrator access is required.</div>;
  return <Suspense fallback={<AppLoader />}><OrganizationsListPage /></Suspense>;
}
