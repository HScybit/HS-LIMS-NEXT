import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import TemplateList from '@/components/templates/TemplateList.jsx';
import { AppLoader } from '@/components/ui/AppLoader.jsx';

export const metadata = { title: 'Master Templates' };
export default async function Page() {
  const identity = await currentIdentity();
  return <Suspense fallback={<AppLoader />}><TemplateList canManage={identity?.permissions.includes('templates.manage')} /></Suspense>;
}
