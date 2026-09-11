import { currentIdentity } from '@/auth/http.js';
import SampleList from '@/components/samples/SampleList.jsx';

export const metadata = { title: 'Samples' };
export default async function Page() {
  const identity = await currentIdentity();
  return <SampleList canCreate={Boolean(identity?.permissions.includes('samples.create'))} />;
}
