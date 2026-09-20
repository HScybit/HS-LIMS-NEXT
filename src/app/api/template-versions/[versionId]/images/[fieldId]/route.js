import { authenticated, endpoint, json } from '@/auth/http.js';
import { uploadTemplateImage } from '@/template-assets/service.js';
import { readTemplateImageUpload } from '@/template-assets/upload.js';
import { templateView } from '@/templates/transport.js';

export const POST = endpoint(async (request, context) => {
  const { versionId, fieldId } = await context.params;
  const result = await authenticated(request, async (client, identity) => uploadTemplateImage(client, identity, versionId, fieldId,
    Number(request.headers.get('x-template-revision')), await readTemplateImageUpload(request)), { permission: 'templates.manage' });
  return json({ model: templateView(result.model), metrics: result.metrics, replayed: result.replayed }, result.replayed ? 200 : 201);
});
