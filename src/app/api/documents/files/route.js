import { authenticated, endpoint, json } from '@/auth/http.js';
import { uploadDocumentFile } from '@/documents/service.js';
import { readCustomFieldAttachmentUpload } from '@/custom-fields/attachment-upload.js';

export const POST = endpoint(async (request) => {
  const { fieldId, fieldRevision, ...upload } = await readCustomFieldAttachmentUpload(request);
  const result = await authenticated(request, (client, identity) => uploadDocumentFile(client, identity, upload));
  return json(result, result.replayed ? 200 : 201);
});
