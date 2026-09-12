import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import WatermarkList from '@/components/report-assets/WatermarkList.jsx';

export const metadata = { title: 'Watermark Report' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><WatermarkList canManage={identity?.permissions.includes('report_settings.manage')} /></Suspense>;
}
