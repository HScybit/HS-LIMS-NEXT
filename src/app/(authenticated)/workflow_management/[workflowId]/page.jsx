import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import WorkflowPage from '@/components/workflows/WorkflowPage.jsx';

export const metadata = { title: 'Workflow Editor' };
export default async function Page({ params }) {
  const identity = await currentIdentity(); const { workflowId } = await params;
  if (!identity?.permissions.some((permission) => ['workflows.read', 'workflows.manage'].includes(permission))) {
    return <div className="alert alert-warning m-4" role="alert">You do not have permission to view workflows.</div>;
  }
  return <Suspense fallback={<AppLoader />}><WorkflowPage key={workflowId} workflowId={workflowId} canManage={identity.permissions.includes('workflows.manage')} /></Suspense>;
}
