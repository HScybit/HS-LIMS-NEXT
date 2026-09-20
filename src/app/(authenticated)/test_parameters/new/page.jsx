import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import TestParameterPage from '@/components/masters/TestParameterPage.jsx';

export const metadata = { title: 'New Test Parameter' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><TestParameterPage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
