import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import BusinessUnitPage from '@/components/masters/BusinessUnitPage.jsx';

export const metadata = { title: 'New Unit' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><BusinessUnitPage mode="create" canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
