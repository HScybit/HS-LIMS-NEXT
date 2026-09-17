import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ServiceAgreementPage from '@/components/masters/ServiceAgreementPage.jsx';

export const metadata = { title: 'View Service Agreement' };
export default async function Page({ params }) {
  const { agreementId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ServiceAgreementPage key={agreementId} agreementId={agreementId} mode="view" canRead={Boolean(identity?.masterModules?.service_agreements)} /></Suspense>;
}
