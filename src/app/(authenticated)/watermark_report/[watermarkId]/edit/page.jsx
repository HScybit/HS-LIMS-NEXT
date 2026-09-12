import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import WatermarkPage from '@/components/report-assets/WatermarkPage.jsx';

export const metadata = { title: 'Edit Watermark Report' };
export default async function Page({ params }) {
  const { watermarkId } = await params; const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><WatermarkPage key={watermarkId} watermarkId={watermarkId} mode="edit" canManage={identity?.permissions.includes('report_settings.manage')} /></Suspense>;
}
