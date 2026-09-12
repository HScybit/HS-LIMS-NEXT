import { authenticated, endpoint } from '@/auth/http.js';
import { readReportImage } from '@/report-assets/images.js';

export const GET = endpoint(async (request, context) => {
  const { imageId } = await context.params;
  const file = await authenticated(request, (client, identity) => readReportImage(client, identity, imageId), { readOnly: true });
  return new Response(file.content, { headers: {
    'Content-Type': file.mediaType, 'Content-Length': String(file.byteLength),
    'Content-Disposition': `inline; filename="report-image.${file.mediaType === 'image/svg+xml' ? 'svg' : file.mediaType.split('/')[1]}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Image-SHA256': file.sha256,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  } });
});
