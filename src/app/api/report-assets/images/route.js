import { authenticated, endpoint, json } from '@/auth/http.js';
import { requirePermission } from '@/templates/input.js';
import { uploadReportImage } from '@/report-assets/images.js';
import { readReportImageUpload } from '@/report-assets/upload.js';

export const POST = endpoint(async (request) => {
  const result = await authenticated(request, async (client, identity) => {
    requirePermission(identity, 'report_settings.manage');
    return uploadReportImage(client, identity, await readReportImageUpload(request));
  });
  return json(result, result.replayed ? 200 : 201);
});
