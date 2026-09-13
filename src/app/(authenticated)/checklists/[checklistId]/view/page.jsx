import { currentIdentity } from '@/auth/http.js';
import ChecklistPage from '@/components/checklists/ChecklistPage.jsx';

export const metadata = { title: 'View Checklist' };
export default async function Page({ params }) {
  const { checklistId } = await params; const identity = await currentIdentity();
  return <ChecklistPage key={checklistId} checklistId={checklistId} mode="view"
    allowed={identity?.permissions.some((permission) => ['checklists.read', 'checklists.manage'].includes(permission))} />;
}
