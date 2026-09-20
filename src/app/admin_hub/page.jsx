import { redirect } from 'next/navigation';
import { currentIdentity } from '@/auth/http.js';
import AdminHubPage from '@/components/admin-hub/AdminHubPage.jsx';

const adminHubPermissions = ['settings.read', 'settings.manage', 'roles.read', 'roles.manage', 'users.read', 'users.manage',
  'checklists.read', 'checklists.manage', 'workflows.read', 'workflows.manage', 'compliance.read', 'compliance.manage'];

export const metadata = { title: 'Admin Hub' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity) redirect('/login?next=%2Fadmin_hub');
  if (!identity.permissions.some((permission) => adminHubPermissions.includes(permission))) {
    return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to view the Admin Hub.</div></div>;
  }
  return <AdminHubPage identity={identity} />;
}
