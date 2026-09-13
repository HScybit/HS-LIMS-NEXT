import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { AppLoader } from '@/components/ui/AppLoader.jsx';
import CustomFieldList from '@/components/masters/CustomFieldList.jsx';

export const metadata = { title: 'Custom Fields' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><CustomFieldList canManage={identity?.permissions.includes('masters.manage')} /></Suspense>;
}
