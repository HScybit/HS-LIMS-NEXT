import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import RolePage from '@/components/roles/RolePage.jsx';

export const metadata = { title: 'New Role' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><RolePage canManage={identity?.permissions.includes('roles.manage')} /></Suspense>;
}
