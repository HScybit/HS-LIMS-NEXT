import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import TestParameterPage from '@/components/masters/TestParameterPage.jsx';

export const metadata = { title: 'View Test Parameter' };
export default async function Page({ params }) {
  const { parameterId } = await params;
  return <Suspense fallback={<AppLoader />}><TestParameterPage key={parameterId} parameterId={parameterId} mode="view" /></Suspense>;
}
