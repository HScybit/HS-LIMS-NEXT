import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ProductList from '@/components/masters/ProductList.jsx';

export const metadata = { title: 'Products' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ProductList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
