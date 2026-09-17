export async function uploadCustomFieldFile(field, file, requestId, signal, { userFields = false, instrumentFields = false } = {}) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Attachments can be at most 20 MiB.');
  const csrf = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  const response = await fetch(instrumentFields ? '/api/instruments/custom-fields/attachments' : userFields ? '/api/users/custom-fields/attachments' : '/api/custom-fields/attachments', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf,
      'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': requestId,
      'X-Custom-Field-Id': field.id, 'X-Custom-Field-Revision': String(field.revision) },
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('The upload response could not be read. Retry the upload.'); }
  if (!response.ok) throw new Error(result.error?.message ?? 'The upload failed. Retry the upload.');
  return result;
}
