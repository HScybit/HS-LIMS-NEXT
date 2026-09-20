import { currentIdentity } from '@/auth/http.js';
import CustomCssManagement from '@/components/report-assets/CustomCssManagement.jsx';

export const metadata = { title: 'Custom CSS' };
export default async function Page() {
  const identity = await currentIdentity();
  return <CustomCssManagement canManage={identity?.permissions.includes('report_settings.manage')} />;
}
