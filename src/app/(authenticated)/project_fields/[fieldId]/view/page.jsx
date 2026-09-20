import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomFieldPage from '@/components/masters/CustomFieldPage.jsx';

export const metadata = { title: 'View Project Field' };
export default async function Page({ params }) {
  const { fieldId } = await params;
  return <Suspense fallback={<AppLoader />}><CustomFieldPage key={fieldId} fieldId={fieldId} mode="view" /></Suspense>;
}
