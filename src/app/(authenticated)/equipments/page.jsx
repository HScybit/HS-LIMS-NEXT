import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import InstrumentList from '@/components/instruments/InstrumentList.jsx';

export const metadata = { title: 'Instruments' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><InstrumentList canRead={Boolean(identity?.masterModules?.instrument)} canManage={Boolean(identity?.masterModules?.instrument && identity.permissions.includes('instruments.manage'))} /></Suspense>;
}
