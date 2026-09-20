import SampleCoa from '@/components/reports/SampleCoa.jsx';

export default async function SampleCoaPage({ params }) {
  const { sampleId } = await params;
  return <SampleCoa key={sampleId} sampleId={sampleId} />;
}
