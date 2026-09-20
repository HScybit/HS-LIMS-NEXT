import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import SampleCategoryPage from '@/components/masters/SampleCategoryPage.jsx';

export const metadata = { title: 'Edit Sample Category' };
export default async function Page({ params }) {
  const { categoryId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><SampleCategoryPage key={categoryId} categoryId={categoryId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
