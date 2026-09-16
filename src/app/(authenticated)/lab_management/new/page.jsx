import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import LaboratoryPage from '@/components/masters/LaboratoryPage.jsx';

export const metadata = { title: 'New Lab' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><LaboratoryPage mode="create" canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
