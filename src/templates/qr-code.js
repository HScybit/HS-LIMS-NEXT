import QRCode from 'qrcode';

// A hand-rolled, synchronous matrix-to-SVG-path renderer (mirroring qrcode's own
// lib/renderer/svg-tag.js output shape) rather than the package's own SVG renderer,
// which is async/callback-based — this needs to run inside React's synchronous
// renderToStaticMarkup(), used for both the live report preview and the frozen PDF
// renderer bundle (TemplateCanvas.jsx is shared by both — see ReportContent.jsx).
function qrPath(data, size, margin) {
  let path = ''; let moveBy = 0; let newRow = false; let lineLength = 0;
  for (let i = 0; i < data.length; i++) {
    const col = i % size; const row = Math.floor(i / size);
    if (!col && !newRow) newRow = true;
    if (data[i]) {
      lineLength++;
      if (!(i > 0 && col > 0 && data[i - 1])) {
        path += newRow ? `M${col + margin} ${0.5 + row + margin}` : `m${moveBy} 0`;
        moveBy = 0; newRow = false;
      }
      if (!(col + 1 < size && data[i + 1])) { path += `h${lineLength}`; lineLength = 0; }
    } else moveBy++;
  }
  return path;
}

// Returns null for empty text (nothing meaningful to encode) rather than throwing —
// callers render a placeholder in that case.
export function qrCodeSvg(text, { margin = 1 } = {}) {
  if (!text) return null;
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size; const data = qr.modules.data; const boxSize = size + margin * 2;
  const path = qrPath(data, size, margin);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boxSize} ${boxSize}" shape-rendering="crispEdges">` +
    `<path fill="#ffffff" d="M0 0h${boxSize}v${boxSize}H0z"/><path stroke="#000000" d="${path}"/></svg>`;
}
