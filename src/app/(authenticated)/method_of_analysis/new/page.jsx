import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MethodPage from '@/components/masters/MethodPage.jsx';

export const metadata = { title: 'New Method of Analysis' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MethodPage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
