import { currentIdentity } from '@/auth/http.js';
import { BulkUploadPreview } from '@/components/masters/BulkPage.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Bulk Upload Preview' };
export default async function Page({ params }) {
  const identity = await currentIdentity(); const { batchId } = await params;
  if (!allowedMasterBulkResources(identity?.permissions, identity?.masterModules).length) return <div className="alert alert-danger m-4" role="alert">You cannot manage bulk uploads.</div>;
  return <BulkUploadPreview key={batchId} batchId={batchId} />;
}
