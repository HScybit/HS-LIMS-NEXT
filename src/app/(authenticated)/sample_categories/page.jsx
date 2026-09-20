import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import SampleCategoryList from '@/components/masters/SampleCategoryList.jsx';

export const metadata = { title: 'Sample Categories' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><SampleCategoryList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
