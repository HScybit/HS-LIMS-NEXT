import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import DecisionRulePage from '@/components/masters/DecisionRulePage.jsx';

export const metadata = { title: 'Edit Decision Rule' };
export default async function Page({ params }) {
  const { ruleId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><DecisionRulePage key={ruleId} ruleId={ruleId} mode="edit" canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
