import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import NablPage from '@/components/compliance/NablPage.jsx';

export const metadata = { title: 'New NABL Certification' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><NablPage mode="new" canManage={identity?.permissions.includes('compliance.manage')} canRead={identity?.permissions.some(code => ['compliance.read', 'compliance.manage'].includes(code))} /></Suspense>;
}
