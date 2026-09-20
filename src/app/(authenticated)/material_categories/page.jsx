import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MaterialCategoryList from '@/components/masters/MaterialCategoryList.jsx';

export const metadata = { title: 'Material Categories' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MaterialCategoryList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
