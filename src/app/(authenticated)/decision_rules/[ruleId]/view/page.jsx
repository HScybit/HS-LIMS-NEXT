import { Suspense } from 'react';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import DecisionRulePage from '@/components/masters/DecisionRulePage.jsx';

export const metadata = { title: 'View Decision Rule' };
export default async function Page({ params }) {
  const { ruleId } = await params;
  return <Suspense fallback={<AppLoader />}><DecisionRulePage key={ruleId} ruleId={ruleId} mode="view" /></Suspense>;
}
