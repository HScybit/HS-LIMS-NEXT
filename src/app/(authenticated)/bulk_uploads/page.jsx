import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { BulkUploadList } from '@/components/masters/BulkPage.jsx';
import { allowedMasterBulkResources } from '@/masters/bulk-config.js';

export const metadata = { title: 'Bulk Uploads' };
export default async function Page() {
  const identity = await currentIdentity();
  const resources = allowedMasterBulkResources(identity?.permissions);
  if (!resources.length) return <div className="alert alert-danger m-4" role="alert">You cannot manage bulk uploads.</div>;
  return <Suspense fallback={<div role="status">Loading uploads…</div>}><BulkUploadList resources={resources} /></Suspense>;
}
