import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ProductPage from '@/components/masters/ProductPage.jsx';

export const metadata = { title: 'Edit Product' };
export default async function Page({ params }) {
  const { productId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><ProductPage key={productId} productId={productId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
