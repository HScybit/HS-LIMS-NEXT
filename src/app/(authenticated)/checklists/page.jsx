import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ChecklistList from '@/components/checklists/ChecklistList.jsx';

export const metadata = { title: 'Checklists' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.permissions.some((permission) => ['checklists.read', 'checklists.manage'].includes(permission))) return <div className="alert alert-warning m-4" role="alert">You do not have permission to view checklists.</div>;
  return <Suspense fallback={<AppLoader />}><ChecklistList canManage={identity.permissions.includes('checklists.manage')} /></Suspense>;
}
