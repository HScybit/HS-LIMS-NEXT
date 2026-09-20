import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import WatermarkPage from '@/components/report-assets/WatermarkPage.jsx';

export const metadata = { title: 'New Watermark Report' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><WatermarkPage mode="new" canManage={identity?.permissions.includes('report_settings.manage')} /></Suspense>;
}
