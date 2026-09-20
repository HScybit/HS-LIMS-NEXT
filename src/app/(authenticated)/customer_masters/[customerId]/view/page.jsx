import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomerPage from '@/components/masters/CustomerPage.jsx';

export const metadata = { title: 'View Customer' };
export default async function Page({ params }) {
  const { customerId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><CustomerPage key={customerId} customerId={customerId} mode="view" canRead={Boolean(identity?.masterModules?.customer)} /></Suspense>;
}
