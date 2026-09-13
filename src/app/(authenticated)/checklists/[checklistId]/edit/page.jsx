import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ChecklistPage from '@/components/checklists/ChecklistPage.jsx';

export const metadata = { title: 'Edit Checklist' };
export default async function Page({ params }) {
  const { checklistId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ChecklistPage key={checklistId} checklistId={checklistId} allowed={identity?.permissions.includes('checklists.manage')} /></Suspense>;
}
