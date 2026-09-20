import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ChecklistPage from '@/components/checklists/ChecklistPage.jsx';

export const metadata = { title: 'New Checklist' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ChecklistPage allowed={identity?.permissions.includes('checklists.manage')} /></Suspense>;
}
