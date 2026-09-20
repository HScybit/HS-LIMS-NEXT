import { authenticated, endpoint, json } from '@/auth/http.js';
import { requirePermission } from '@/templates/input.js';
import { uploadCustomFieldAttachment } from '@/custom-fields/attachments.js';
import { readCustomFieldAttachmentUpload } from '@/custom-fields/attachment-upload.js';

export const POST = endpoint(async (request) => {
  const result = await authenticated(request, async (client, identity) => {
    requirePermission(identity, 'masters.manage');
    return uploadCustomFieldAttachment(client, identity, await readCustomFieldAttachmentUpload(request));
  });
  return json(result, result.replayed ? 200 : 201);
});
