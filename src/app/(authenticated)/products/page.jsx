import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ProductList from '@/components/masters/ProductList.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Products' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ProductList canManage={identity?.permissions.includes('masters.manage')} bulkResources={allowedMasterBulkResources(identity?.permissions, identity?.masterModules)} /></Suspense>;
}
