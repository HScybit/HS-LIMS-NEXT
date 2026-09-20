export function sanitizeTemplatePreviewHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|form|base)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|form|base)\s*>/gi, '')
    .replace(/<(?:iframe|object|embed|form|base)\b[^>]*\/?\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
}
