import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MethodPage from '@/components/masters/MethodPage.jsx';

export const metadata = { title: 'Edit Method of Analysis' };
export default async function Page({ params }) {
  const { methodId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MethodPage key={methodId} methodId={methodId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
