import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MaterialCategoryPage from '@/components/masters/MaterialCategoryPage.jsx';

export const metadata = { title: 'Edit Material Category' };
export default async function Page({ params }) {
  const { categoryId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MaterialCategoryPage key={categoryId} categoryId={categoryId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
