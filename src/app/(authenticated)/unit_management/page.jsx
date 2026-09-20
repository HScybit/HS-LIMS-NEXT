import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import BusinessUnitList from '@/components/masters/BusinessUnitList.jsx';

export const metadata = { title: 'Units' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><BusinessUnitList canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
