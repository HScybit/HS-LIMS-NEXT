import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import InstrumentPage from '@/components/instruments/InstrumentPage.jsx';

export const metadata = { title: 'View Instrument' };
export default async function Page({ params }) {
  const { instrumentId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><InstrumentPage key={instrumentId} instrumentId={instrumentId} mode="view" canRead={Boolean(identity?.masterModules?.instrument)} canManage={Boolean(identity?.masterModules?.instrument && identity.permissions.includes('instruments.manage'))} /></Suspense>;
}
