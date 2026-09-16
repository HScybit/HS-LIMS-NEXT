// Source QR label layout; event listeners work under the application Content Security Policy.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function printQrCode({ materialName, uniqueKey, link, qrDataUrl }) {
  const printWindow = window.open('', '_blank', 'width=420,height=560');
  if (!printWindow) return false;

  // document.open clears window listeners; register print callbacks afterwards.
  printWindow.document.open();
  printWindow.addEventListener('load', () => { printWindow.focus(); printWindow.print(); }, { once: true });
  printWindow.addEventListener('afterprint', () => printWindow.close(), { once: true });
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>${escapeHtml(materialName)} QR</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #1c2126;
            font-family: Arial, sans-serif;
          }
          .qr-label {
            width: 76mm;
            min-height: 92mm;
            padding: 10mm 8mm;
            border: 1px solid #d7dde5;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4mm;
            text-align: center;
          }
          .qr-label img {
            width: 42mm;
            height: 42mm;
            image-rendering: pixelated;
          }
          .qr-title {
            margin: 0;
            font-size: 14pt;
            line-height: 1.2;
            font-weight: 700;
          }
          .qr-meta {
            margin: 0;
            color: #4d5561;
            font-size: 9pt;
            line-height: 1.3;
            overflow-wrap: anywhere;
          }
          @page { margin: 8mm; }
          @media print {
            body { min-height: auto; }
            .qr-label { border-color: #000; break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <section class="qr-label">
          <img src="${qrDataUrl}" alt="QR code for ${escapeHtml(materialName)}" />
          <h1 class="qr-title">${escapeHtml(materialName)}</h1>
          ${uniqueKey ? `<p class="qr-meta">Key: ${escapeHtml(uniqueKey)}</p>` : ''}
          <p class="qr-meta">${escapeHtml(link)}</p>
        </section>
      </body>
    </html>
  `);
  printWindow.document.close();
  return true;
}
