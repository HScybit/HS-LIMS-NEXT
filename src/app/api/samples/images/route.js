import { authenticated, endpoint, json } from '@/auth/http.js';
import { requireSampleImageUpload, uploadSampleImage } from '@/samples/images.js';
import { readSampleImageUpload } from '@/samples/image-upload.js';

export const POST = endpoint(async request => {
  const result = await authenticated(request, async (client, identity) => {
    requireSampleImageUpload(identity);
    return uploadSampleImage(client, identity, await readSampleImageUpload(request));
  });
  return json(result, result.replayed ? 200 : 201);
});
