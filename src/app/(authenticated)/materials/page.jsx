import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import MaterialsList from '@/components/materials/MaterialsList.jsx';

export const metadata = { title: 'Materials' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><MaterialsList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
