import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomerPage from '@/components/masters/CustomerPage.jsx';

export const metadata = { title: 'Edit Customer' };
export default async function Page({ params }) {
  const { customerId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><CustomerPage key={customerId} customerId={customerId} mode="edit" canRead={Boolean(identity?.masterModules?.customer)} canManage={Boolean(identity?.masterModules?.customer && identity.permissions.includes('masters.manage'))} /></Suspense>;
}
