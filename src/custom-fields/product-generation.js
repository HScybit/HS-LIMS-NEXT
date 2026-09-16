const escapePattern = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counterTokens = new Set(['scheme_counter', 'scheme_category_counter']);
const blockedParts = new Set(['__proto__', 'prototype', 'constructor']);
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

export function schemeNumber(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) ? number : fallback;
}

export function padSchemeNumber(value, field, fallbackWidth = 0) {
  const text = String(value ?? ''); const padding = schemeNumber(field.paddedNumber);
  // The source editor configures a count of leading zeroes, not a total width.
  if (padding > 0) return '0'.repeat(padding) + text;
  const width = schemeNumber(fallbackWidth);
  return width > 0 ? text.padStart(width, '0') : text;
}

function counterNumber(value) {
  const text = String(value ?? ''); const number = schemeNumber(text, null);
  if (number !== null) return number;
  const parts = text.match(/\d+/g); return schemeNumber(parts?.[parts.length - 1]);
}

export function parseSchemeCounter(value, field, counterToken, finalPattern = '') {
  const text = String(value ?? ''); const splitter = field.splitter || '';
  if (splitter) {
    const index = String(field.scheme || '').split(splitter).findIndex((part) =>
      part.trim().replace(/\{\{\s*/, '{{').replace(/\s*\}\}/, '}}') === `{{${counterToken}}}`);
    if (index >= 0) return counterNumber(text.split(splitter)[index]);
  }
  const wildcard = finalPattern.indexOf('.*');
  if (text && wildcard !== -1) {
    const prefix = finalPattern.slice(0, wildcard); const suffix = finalPattern.slice(wildcard + 2);
    const match = new RegExp(`${escapePattern(prefix)}${suffix ? '(.+?)' : '(.+)'}${escapePattern(suffix)}`).exec(text);
    if (match) return counterNumber(match[1]);
  }
  return counterNumber(text);
}

export function normalizeSchemeValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeSchemeValue).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return normalizeSchemeValue(value.display_value ?? value.value ?? value.name ?? value.label ?? value._id ?? value.key);
  return value == null ? '' : String(value);
}

function ownValue(source, path) {
  const parts = path.split('.');
  if (!path || parts.some((part) => !/^[A-Za-z0-9_]+$/.test(part) || blockedParts.has(part))) return '';
  const value = parts.reduce((current, part) => current != null && Object.hasOwn(Object(current), part) ? current[part] : undefined, source);
  return normalizeSchemeValue(value);
}

export function schemeTokens(scheme) {
  return [...String(scheme || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1].trim()).filter(Boolean);
}
function replaceToken(scheme, token, value) {
  // A string replacement deliberately preserves the source's $&, $`, $' and $$ semantics.
  return String(scheme || '').replace(new RegExp(`\\{\\{\\s*${escapePattern(token)}\\s*\\}\\}`, 'g'), value == null ? '' : String(value));
}
const finish = (value) => value.replace(/}}/g, '').replace(/{{/g, '');

// The caller supplies an explicit clock/zone, tenant settings, batched counts and a latest-value reader.
// The source Product, Parameter and Method forms have no hidden NABL/category/customer context.
async function generateMasterScheme({ field, doc, settings = {}, clock, counts, latestValue }, kind) {
  async function tokenValue(token) {
    switch (token) {
      case 'financial_year': {
        const year = clock.month <= 3 ? clock.year - 1 : clock.year;
        return `${String(year).slice(-schemeNumber(settings.currentYearDigits, 2))}${settings.separator ?? '-'}${String(year + 1).slice(-schemeNumber(settings.nextYearDigits, 2))}`;
      }
      case 'current_year': return String(clock.year).slice(-schemeNumber(settings.currentYearDigits, 4));
      case 'current_month': return settings.currentMonthFormat === 'long' ? monthNames[clock.month - 1]
        : settings.currentMonthFormat === 'short' ? shortMonths[clock.month - 1] : String(clock.month).padStart(2, '0');
      case 'timestamp': return clock.timestamp;
      case 'timestamp_date': return `${String(clock.day).padStart(2, '0')}-${String(clock.month).padStart(2, '0')}-${clock.year}`;
      case 'timestamp_date_day': return String(clock.day).padStart(2, '0');
      case 'scheme_counter':
      case 'scheme_category_counter': {
        let pattern = replaceToken(field.scheme, token, '.*');
        for (const item of schemeTokens(pattern)) pattern = replaceToken(pattern, item, counterTokens.has(item) ? '.*' : await tokenValue(item));
        pattern = finish(pattern);
        const previous = await latestValue({ fieldId: field.id, pattern });
        return padSchemeNumber(parseSchemeCounter(previous, field, token, pattern) + 1, field);
      }
      case 'nabl_counter':
      case 'total_counter': return padSchemeNumber(schemeNumber(settings.nonNablStartNumber, 1) + counts.records, field);
      case 'samples_counter':
      case 'sample_category_counter': return padSchemeNumber(counts.samples + 1, field);
      case 'product_name': return kind === 'product' ? doc.name || '' : '';
      case 'product_abbr': return kind === 'product' ? doc.abbr || '' : '';
      case 'nabl_term': return field.nonNablDisplayTerm || '';
      case 'category_name':
      case 'category_abbr':
      case 'customer_name':
      case 'customer_abbr':
      case 'business_unit':
      case 'business_sub_unit':
      case 'sample_id':
      case 'amendment_number': return '';
      default: return token.startsWith('entity.') ? ownValue(doc, token.slice('entity.'.length))
        : normalizeSchemeValue(Object.hasOwn(doc.project_field_data ?? {}, token) ? doc.project_field_data[token] : undefined) || ownValue(doc, token);
    }
  }
  let value = field.scheme || '';
  for (const token of schemeTokens(value)) value = replaceToken(value, token, await tokenValue(token));
  return finish(value);
}

export const generateProductScheme = (input) => generateMasterScheme({ ...input, counts: { ...input.counts, records: input.counts?.products } }, 'product');
export const generateParameterScheme = (input) => generateMasterScheme({ ...input, counts: { ...input.counts, records: input.counts?.parameters } }, 'parameter');
export const generateMethodScheme = (input) => generateMasterScheme({ ...input, counts: { ...input.counts, records: input.counts?.methods } }, 'method');
