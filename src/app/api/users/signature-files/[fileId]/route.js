import { authenticated, endpoint } from '@/auth/http.js';
import { readUserSignatureFile, userSignatureFileHeaders } from '@/users/signatures.js';

export const GET = endpoint(async (request, context) => {
  const { fileId } = await context.params;
  const file = await authenticated(request, (client, identity) => readUserSignatureFile(client, identity, fileId), { readOnly: true });
  return new Response(file.content, { headers: userSignatureFileHeaders(file, { view: request.nextUrl.searchParams.get('view') === '1' }) });
});
