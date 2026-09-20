import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import DecisionRulePage from '@/components/masters/DecisionRulePage.jsx';

export const metadata = { title: 'New Decision Rule' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><DecisionRulePage mode="new" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
