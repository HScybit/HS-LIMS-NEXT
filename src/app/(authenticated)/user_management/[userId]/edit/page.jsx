import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import UserPage from '@/components/users/UserPage.jsx';

export const metadata = { title: 'Edit User' };
export default async function Page({ params }) {
  const { userId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><UserPage key={`${identity?.organizationId}:${identity?.userId}:${userId}`} mode="edit" userId={userId} currentUserId={identity?.userId}
    canRead={Boolean(identity?.permissions.some(permission => ['users.read', 'users.manage'].includes(permission)))} canManage={Boolean(identity?.permissions.includes('users.manage'))} /></Suspense>;
}
