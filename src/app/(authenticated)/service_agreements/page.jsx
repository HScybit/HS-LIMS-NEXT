import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ServiceAgreementList from '@/components/masters/ServiceAgreementList.jsx';

export const metadata = { title: 'Service Agreements' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ServiceAgreementList canRead={Boolean(identity?.masterModules?.service_agreements)}
    canManage={Boolean(identity?.masterModules?.service_agreements && identity.permissions.includes('masters.manage'))} /></Suspense>;
}
