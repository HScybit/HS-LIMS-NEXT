function escapedTitle(value) {
  return String(value).replace(/[<>&"]/g, '');
}

function pageStyles() {
  return [...document.styleSheets].map((sheet) => {
    try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); }
    catch { return ''; }
  }).join('\n');
}

export function buildPreviewDocument(root, title) {
  const inlineStyles = [...document.querySelectorAll('style')].map((node) => node.textContent || '').join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapedTitle(title)}</title><style>${pageStyles()}\n${inlineStyles}\nhtml,body{margin:0;background:#fff}.template-preview-document{width:100%!important;min-height:0!important;margin:0!important;border:0!important;box-shadow:none!important}</style></head><body><article class="template-preview-document"><div data-coa-report-body>${root.innerHTML}</div></article></body></html>`;
}
