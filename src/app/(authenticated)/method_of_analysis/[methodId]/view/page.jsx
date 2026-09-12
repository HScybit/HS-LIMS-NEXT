import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MethodPage from '@/components/masters/MethodPage.jsx';

export const metadata = { title: 'View Method of Analysis' };
export default async function Page({ params }) {
  const { methodId } = await params;
  return <Suspense fallback={<AppLoader />}><MethodPage key={methodId} methodId={methodId} mode="view" /></Suspense>;
}
