import { redirect } from 'next/navigation';
import { currentIdentity } from '@/auth/http.js';
import TemplatePreview from '@/components/templates/TemplatePreview.jsx';

export const metadata = { title: 'Template Preview' };
export default async function Page({ params, searchParams }) {
  const { templateId } = await params;
  const { version } = await searchParams;
  if (!await currentIdentity()) redirect(`/login?next=${encodeURIComponent(`/master_template_management/${templateId}/preview`)}`);
  return <TemplatePreview templateId={templateId} versionId={typeof version === 'string' ? version : undefined} />;
}
