import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomFieldPage from '@/components/masters/CustomFieldPage.jsx';

export const metadata = { title: 'New Project Field' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><CustomFieldPage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
