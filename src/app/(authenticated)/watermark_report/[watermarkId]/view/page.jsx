import WatermarkPage from '@/components/report-assets/WatermarkPage.jsx';

export const metadata = { title: 'Watermark Report Details' };
export default async function Page({ params }) {
  const { watermarkId } = await params;
  return <WatermarkPage key={watermarkId} watermarkId={watermarkId} mode="view" />;
}
