import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import ProductPage from '@/components/masters/ProductPage.jsx';

export const metadata = { title: 'View Product' };
export default async function Page({ params }) {
  const { productId } = await params;
  return <Suspense fallback={<AppLoader />}><ProductPage key={productId} productId={productId} mode="view" /></Suspense>;
}
