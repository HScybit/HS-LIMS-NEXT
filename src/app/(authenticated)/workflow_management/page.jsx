import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import WorkflowList from '@/components/workflows/WorkflowList.jsx';

export const metadata = { title: 'Workflow Master' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.permissions.some((permission) => ['workflows.read', 'workflows.manage'].includes(permission))) {
    return <div className="alert alert-warning m-4" role="alert">You do not have permission to view workflows.</div>;
  }
  return <Suspense fallback={<AppLoader />}><WorkflowList canManage={identity.permissions.includes('workflows.manage')} /></Suspense>;
}
