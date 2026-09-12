import TestRequestDetails from '@/components/test-requests/TestRequestDetails.jsx';

export const metadata = { title: 'Test Request' };
export default async function Page({ params, searchParams }) {
  const { sampleId, requestId } = await params;
  const { datasheetId } = await searchParams;
  const selectedId = typeof datasheetId === 'string' ? datasheetId : '';
  return <TestRequestDetails key={`${requestId}:${selectedId}`} requestId={requestId} sampleId={sampleId} initialDatasheetId={selectedId} />;
}
