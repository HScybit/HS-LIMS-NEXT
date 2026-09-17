import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ServiceAgreementPage from '@/components/masters/ServiceAgreementPage.jsx';

export const metadata = { title: 'New Service Agreement' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ServiceAgreementPage mode="new" canRead={Boolean(identity?.masterModules?.service_agreements)}
    canManage={Boolean(identity?.masterModules?.service_agreements && identity.permissions.includes('masters.manage'))} /></Suspense>;
}
