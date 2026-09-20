import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import VendorPage from '@/components/masters/VendorPage.jsx';

export const metadata = { title: 'New Vendor' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><VendorPage mode="new" canRead={Boolean(identity?.masterModules?.vendor)} canManage={Boolean(identity?.masterModules?.vendor && identity.permissions.includes('masters.manage'))} /></Suspense>;
}
