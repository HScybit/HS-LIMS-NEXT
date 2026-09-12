export class ReportImageUploadAdapter {
  constructor(loader) {
    this.loader = loader;
    this.requestId = crypto.randomUUID();
    this.controller = new AbortController();
  }

  async upload() {
    const file = await this.loader.file;
    if (this.controller.signal.aborted) throw new Error('Upload cancelled.');
    if (!file) throw new Error('No image selected.');
    const csrfToken = document.cookie.split('; ').find((item) => item.startsWith('sampleify_csrf='))?.slice('sampleify_csrf='.length) ?? '';
    const response = await fetch('/api/report-assets/images', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      signal: this.controller.signal, body: file, headers: {
        'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Upload-Request-Id': this.requestId, 'X-CSRF-Token': csrfToken,
      } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'The image could not be uploaded.');
    if (!result.url?.startsWith('/api/report-assets/images/')) throw new Error('The image upload did not return a file URL.');
    return { default: result.url };
  }

  abort() { this.controller.abort(); }
}
