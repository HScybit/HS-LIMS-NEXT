import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ProductPage from '@/components/masters/ProductPage.jsx';

export const metadata = { title: 'New Product' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ProductPage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
