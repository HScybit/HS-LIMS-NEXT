import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import RoleList from '@/components/roles/RoleList.jsx';

export const metadata = { title: 'Role Master' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.permissions.some((permission) => ['roles.read', 'roles.manage'].includes(permission))) {
    return <div className="alert alert-warning m-4" role="alert">You do not have permission to view roles.</div>;
  }
  return <Suspense fallback={<AppLoader />}><RoleList canManage={identity.permissions.includes('roles.manage')} /></Suspense>;
}
