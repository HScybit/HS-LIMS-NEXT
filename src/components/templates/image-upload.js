export async function uploadTemplateImageFile(file, { versionId, fieldId, revision, requestId }) {
  const csrfToken = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`/api/template-versions/${versionId}/images/${fieldId}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': requestId, 'X-Template-Revision': String(revision), 'X-CSRF-Token': csrfToken } });
      const result = await response.json();
      if (!response.ok) { const failure = new Error(result.error?.message ?? 'Unable to upload image.'); failure.status = response.status; throw failure; }
      return result;
    } catch (failure) {
      if (attempt || failure.status && failure.status < 500) throw failure;
    }
  }
}
