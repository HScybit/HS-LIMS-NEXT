import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import UserPage from '@/components/users/UserPage.jsx';

export const metadata = { title: 'New User' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><UserPage key={`${identity?.organizationId}:${identity?.userId}`} mode="new" currentUserId={identity?.userId} canManage={Boolean(identity?.permissions.includes('users.manage'))} /></Suspense>;
}
