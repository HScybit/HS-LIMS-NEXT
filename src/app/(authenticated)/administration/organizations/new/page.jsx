import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import OrganizationFormPage from '@/components/administration/OrganizationFormPage.jsx';

export const metadata = { title: 'New Organization' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.isPlatformAdministrator) return <div className="alert alert-warning m-4" role="alert">Platform administrator access is required.</div>;
  return <Suspense fallback={<AppLoader />}><OrganizationFormPage /></Suspense>;
}
