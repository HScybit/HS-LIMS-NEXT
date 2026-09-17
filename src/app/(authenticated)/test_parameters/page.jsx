import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import TestParameterList from '@/components/masters/TestParameterList.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Test Parameters' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><TestParameterList canManage={identity?.permissions.includes('masters.manage')} bulkResources={allowedMasterBulkResources(identity?.permissions)} /></Suspense>;
}
