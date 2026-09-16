import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import NablPage from '@/components/compliance/NablPage.jsx';

export const metadata = { title: 'Edit NABL Certification' };
export default async function Page({ params }) {
  const identity = await currentIdentity();
  const { certificationId } = await params;
  return <Suspense fallback={<AppLoader />}><NablPage certificationId={certificationId} mode="edit" canManage={identity?.permissions.includes('compliance.manage')} canRead={identity?.permissions.some(code => ['compliance.read', 'compliance.manage'].includes(code))} /></Suspense>;
}
