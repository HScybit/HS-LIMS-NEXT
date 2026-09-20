import SampleDetails from '@/components/samples/SampleDetails.jsx';

export const metadata = { title: 'Sample Details' };
export default async function Page({ params }) {
  const { sampleId } = await params;
  return <SampleDetails sampleId={sampleId} />;
}
