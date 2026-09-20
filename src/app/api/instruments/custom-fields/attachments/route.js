import { authenticated, endpoint, json } from '@/auth/http.js';
import { requirePermission } from '@/templates/input.js';
import { readCustomFieldAttachmentUpload } from '@/custom-fields/attachment-upload.js';
import { uploadInstrumentFieldAttachment } from '@/instruments/custom-field-attachments.js';

export const POST = endpoint(async request => {
  const result = await authenticated(request, async (client, identity) => {
    requirePermission(identity, 'instruments.manage');
    return uploadInstrumentFieldAttachment(client, identity, await readCustomFieldAttachmentUpload(request));
  });
  return json(result, result.replayed ? 200 : 201);
});
