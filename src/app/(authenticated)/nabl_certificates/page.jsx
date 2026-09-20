import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import NablList from '@/components/compliance/NablList.jsx';

export const metadata = { title: 'NABL Certification Management' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><NablList canManage={identity?.permissions.includes('compliance.manage')} canRead={identity?.permissions.some(code => ['compliance.read', 'compliance.manage'].includes(code))} /></Suspense>;
}
