import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import VendorList from '@/components/masters/VendorList.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Vendors' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><VendorList canRead={Boolean(identity?.masterModules?.vendor)} canManage={Boolean(identity?.masterModules?.vendor && identity.permissions.includes('masters.manage'))}
    bulkResources={allowedMasterBulkResources(identity?.permissions, identity?.masterModules)} /></Suspense>;
}
