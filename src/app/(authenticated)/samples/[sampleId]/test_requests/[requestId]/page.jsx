import TestRequestDetails from '@/components/test-requests/TestRequestDetails.jsx';

export const metadata = { title: 'Test Request' };
export default async function Page({ params }) {
  const { sampleId, requestId } = await params;
  return <TestRequestDetails key={requestId} requestId={requestId} sampleId={sampleId} />;
}
