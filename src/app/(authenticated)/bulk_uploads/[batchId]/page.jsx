import { currentIdentity } from '@/auth/http.js';
import { BulkUploadPreview } from '@/components/masters/BulkPage.jsx';

export const metadata = { title: 'Bulk Upload Preview' };
export default async function Page({ params }) {
  const identity = await currentIdentity(); const { batchId } = await params;
  if (!identity?.permissions.includes('masters.manage')) return <div className="alert alert-danger m-4" role="alert">You cannot manage bulk uploads.</div>;
  return <BulkUploadPreview key={batchId} batchId={batchId} />;
}
