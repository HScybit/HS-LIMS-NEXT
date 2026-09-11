import DatasheetResults from '@/components/datasheets/DatasheetResults.jsx';

export const metadata = { title: 'Add Results' };
export default async function Page({ params, searchParams }) {
  const { sampleId, datasheetId } = await params;
  const { revision } = await searchParams;
  return <DatasheetResults key={`${datasheetId}:${revision ?? ''}`} datasheetId={datasheetId} sampleId={sampleId} requestedRevision={revision} />;
}
