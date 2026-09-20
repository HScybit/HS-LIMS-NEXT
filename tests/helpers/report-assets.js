import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { uploadReportImage } from '../../src/report-assets/images.js';
import { saveReportDocument } from '../../src/report-assets/documents.js';

export async function createReportAssets(client, identity) {
  const content = await sharp({ create: { width: 80, height: 24, channels: 3, background: '#005577' } }).png().toBuffer();
  const image = await uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Synthetic logo.png', mediaType: 'image/png', content });
  const headerInput = { documentId: randomUUID(), requestId: randomUUID(), revision: 0, type: 'header', name: 'Synthetic report header',
    templateHtml: `<p style="margin:0">FROZEN LABORATORY HEADER</p><figure class="image"><img src="${image.url}" alt="Synthetic logo" width="80" height="24"></figure>`, isDefault: true };
  const footerInput = { documentId: randomUUID(), requestId: randomUUID(), revision: 0, type: 'footer', name: 'Synthetic report footer',
    templateHtml: '<p style="margin:0;text-align:right">FROZEN LABORATORY FOOTER</p>', isDefault: false };
  const header = await saveReportDocument(client, identity, headerInput);
  const footer = await saveReportDocument(client, identity, footerInput);
  return { image, content, headerInput, footerInput, header: header.document, footer: footer.document,
    command: { type: 'setReportAssets', headerDocumentId: header.document.id, footerDocumentId: footer.document.id, nablHeaderDocumentId: null, nablFooterDocumentId: null } };
}
