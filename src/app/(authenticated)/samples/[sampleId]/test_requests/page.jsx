import SampleTestRequestList from '@/components/test-requests/SampleTestRequestList.jsx';

export const metadata = { title: 'Test Requests' };
export default async function Page({ params }) {
  const { sampleId } = await params;
  return <SampleTestRequestList sampleId={sampleId} />;
}
