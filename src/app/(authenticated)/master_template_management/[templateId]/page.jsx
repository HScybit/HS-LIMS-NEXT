import { currentIdentity } from '@/auth/http.js';
import TemplateDesigner from '@/components/templates/TemplateDesigner.jsx';

export const metadata = { title: 'Template Designer' };
export default async function Page({ params }) {
  const { templateId } = await params;
  const identity = await currentIdentity();
  return <TemplateDesigner templateId={templateId} canManage={identity?.permissions.includes('templates.manage')} />;
}
