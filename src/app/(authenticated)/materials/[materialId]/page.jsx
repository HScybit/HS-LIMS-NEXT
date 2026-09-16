import { currentIdentity } from '@/auth/http.js';
import MaterialDetail from '@/components/materials/MaterialDetail.jsx';

export const metadata = { title: 'Material' };
export default async function Page({ params }) {
  const { materialId } = await params; const identity = await currentIdentity();
  return <MaterialDetail materialId={materialId} canManage={identity?.permissions.includes('masters.manage')} />;
}
