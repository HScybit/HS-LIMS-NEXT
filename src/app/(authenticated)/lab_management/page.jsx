import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import LaboratoryList from '@/components/masters/LaboratoryList.jsx';

export const metadata = { title: 'Labs' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><LaboratoryList canManage={identity?.permissions.includes('users.manage')} /></Suspense>;
}
