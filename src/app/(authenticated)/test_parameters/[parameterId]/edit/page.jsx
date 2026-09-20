import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import TestParameterPage from '@/components/masters/TestParameterPage.jsx';

export const metadata = { title: 'Edit Test Parameter' };
export default async function Page({ params }) {
  const { parameterId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><TestParameterPage key={parameterId} parameterId={parameterId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
