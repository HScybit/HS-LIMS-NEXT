import { userSignatureByteLimit } from './signature-policy.js';
import { apiRequest } from '../lib/api-client.js';

export async function saveUserSignature(userId, { file, requestId, revision }) {
  if (!file) return apiRequest(`/api/users/${userId}/signature`, { method: 'DELETE', body: { requestId, revision } });
  if (file.size > userSignatureByteLimit) throw new Error('Signature files can be at most 20 MiB.');
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch(`/api/users/${userId}/signature`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf, 'X-File-Name': encodeURIComponent(file.name),
      'X-Upload-Request-Id': requestId, 'X-Signature-Revision': String(revision) } });
  let result;
  try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
  if (!response.ok) { const error = new Error(result.error?.message ?? 'The signature upload failed.'); error.code = result.error?.code; error.status = response.status; throw error; }
  return result;
}
