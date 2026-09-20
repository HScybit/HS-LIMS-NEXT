import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MaterialCategoryPage from '@/components/masters/MaterialCategoryPage.jsx';

export const metadata = { title: 'New Material Category' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MaterialCategoryPage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
