import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import SampleCategoryPage from '@/components/masters/SampleCategoryPage.jsx';

export const metadata = { title: 'View Sample Category' };
export default async function Page({ params }) {
  const { categoryId } = await params;
  return <Suspense fallback={<AppLoader />}><SampleCategoryPage key={categoryId} categoryId={categoryId} mode="view" /></Suspense>;
}
