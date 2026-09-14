import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import UserList from '@/components/users/UserList.jsx';

export const metadata = { title: 'User Management' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.permissions.some(permission => ['users.read', 'users.manage'].includes(permission))) return <div className="alert alert-warning m-4" role="alert">You do not have permission to view users.</div>;
  return <Suspense fallback={<AppLoader />}><UserList key={`${identity.organizationId}:${identity.userId}`} currentUserId={identity.userId} canManage={identity.permissions.includes('users.manage')} /></Suspense>;
}
