import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import VendorPage from '@/components/masters/VendorPage.jsx';

export const metadata = { title: 'View Vendor' };
export default async function Page({ params }) {
  const { vendorId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><VendorPage key={vendorId} vendorId={vendorId} mode="view" canRead={Boolean(identity?.masterModules?.vendor)} /></Suspense>;
}
