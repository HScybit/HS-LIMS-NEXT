import { Suspense } from 'react';
import { currentIdentity } from '@/auth/http.js';
import { BulkUploadList } from '@/components/masters/BulkPage.jsx';

export const metadata = { title: 'Bulk Uploads' };
export default async function Page() {
  const identity = await currentIdentity();
  if (!identity?.permissions.includes('masters.manage')) return <div className="alert alert-danger m-4" role="alert">You cannot manage bulk uploads.</div>;
  return <Suspense fallback={<div role="status">Loading uploads…</div>}><BulkUploadList /></Suspense>;
}
