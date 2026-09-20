import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import LaboratoryPage from '@/components/masters/LaboratoryPage.jsx';

export const metadata = { title: 'Edit Lab' };
export default async function Page({ params }) {
  const identity = await currentIdentity();
  const { laboratoryId } = await params;
  return <Suspense fallback={<AppLoader />}><LaboratoryPage laboratoryId={laboratoryId} mode="edit" canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
