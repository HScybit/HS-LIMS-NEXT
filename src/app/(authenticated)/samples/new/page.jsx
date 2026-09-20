import { currentIdentity } from '@/auth/http.js';
import SampleRegistration from '@/components/samples/SampleRegistration.jsx';

export const metadata = { title: 'New Sample' };
export default async function Page({ searchParams }) {
  const identity = await currentIdentity();
  const query = await searchParams;
  return <SampleRegistration requestedKind={typeof query.sample_type === 'string' ? query.sample_type : 'base'} receivedByName={identity?.displayName ?? ''}
    canCreate={Boolean(identity?.permissions.includes('samples.create'))} canRead={Boolean(identity?.permissions.includes('samples.read'))} />;
}
