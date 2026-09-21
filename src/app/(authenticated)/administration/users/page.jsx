import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import PlatformUsersPage from '@/components/administration/PlatformUsersPage.jsx';

export const metadata = { title: 'Users' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.isPlatformAdministrator) return <div className="alert alert-warning m-4" role="alert">Platform administrator access is required.</div>;
  return <Suspense fallback={<AppLoader />}><PlatformUsersPage /></Suspense>;
}
