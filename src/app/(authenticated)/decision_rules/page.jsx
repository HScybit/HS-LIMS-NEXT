import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import DecisionRuleList from '@/components/masters/DecisionRuleList.jsx';

export const metadata = { title: 'Decision Rules' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><DecisionRuleList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
