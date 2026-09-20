import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MethodList from '@/components/masters/MethodList.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Method of Analysis' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MethodList canManage={identity?.permissions.includes('masters.manage')} bulkResources={allowedMasterBulkResources(identity?.permissions, identity?.masterModules)} /></Suspense>;
}
