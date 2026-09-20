import { currentIdentity } from '@/auth/http.js';
import SampleRegistration from '@/components/samples/SampleRegistration.jsx';

export const metadata = { title: 'Edit Sample' };
export default async function Page({ params }) {
  const identity = await currentIdentity(); const { sampleId } = await params;
  return <SampleRegistration key={sampleId} sampleId={sampleId} canManage={Boolean(identity?.permissions.includes('samples.manage'))}
    canCreate={Boolean(identity?.permissions.includes('samples.create'))} canRead={Boolean(identity?.permissions.includes('samples.read'))} />;
}
