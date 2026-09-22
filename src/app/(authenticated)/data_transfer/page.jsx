import { currentIdentity } from '@/auth/http.js';
import DataTransferPage from '@/components/masters/DataTransferPage.jsx';
import { dataTransferAccess } from '@/masters/data-transfer.js';

export const metadata = { title: 'Data Transfer' };
export default async function Page() {
  const identity = await currentIdentity();
  const access = dataTransferAccess(identity?.permissions, identity?.masterModules);
  if (!access.importable.length && !access.exportable.length) return <div className="alert alert-danger m-4" role="alert">You cannot transfer data.</div>;
  return <DataTransferPage canImport={access.importable.length > 0} canExport={access.exportable.length > 0} />;
}
