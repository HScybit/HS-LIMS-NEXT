import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import BusinessUnitPage from '@/components/masters/BusinessUnitPage.jsx';

export const metadata = { title: 'Edit Unit' };
export default async function Page({ params }) {
  const identity = await currentIdentity();
  const { unitId } = await params;
  return <Suspense fallback={<AppLoader />}><BusinessUnitPage unitId={unitId} mode="edit" canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
