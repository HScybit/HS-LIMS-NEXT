import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MaterialCategoryPage from '@/components/masters/MaterialCategoryPage.jsx';

export const metadata = { title: 'View Material Category' };
export default async function Page({ params }) {
  const { categoryId } = await params;
  return <Suspense fallback={<AppLoader />}><MaterialCategoryPage key={categoryId} categoryId={categoryId} mode="view" /></Suspense>;
}
