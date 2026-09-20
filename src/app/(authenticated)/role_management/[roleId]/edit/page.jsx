import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import RolePage from '@/components/roles/RolePage.jsx';

export const metadata = { title: 'Edit Role' };
export default async function Page({ params }) {
  const { roleId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><RolePage key={roleId} roleId={roleId} canManage={identity?.permissions.includes('roles.manage')} /></Suspense>;
}
