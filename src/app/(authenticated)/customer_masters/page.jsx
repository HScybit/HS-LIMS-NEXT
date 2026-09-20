import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomerList from '@/components/masters/CustomerList.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Customer Masters' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><CustomerList canRead={Boolean(identity?.masterModules?.customer)} canManage={Boolean(identity?.masterModules?.customer && identity.permissions.includes('masters.manage'))}
    bulkResources={allowedMasterBulkResources(identity?.permissions, identity?.masterModules)} /></Suspense>;
}
