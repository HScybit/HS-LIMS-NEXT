const own = (record, key) => record != null && Object.hasOwn(record, key) ? record[key] : undefined;

// Only recorded specification/version columns enter the render model. Missing
// old master history must not acquire values from a later mutable revision.
export function parameterTitleProjection(row, customFields) {
  if (!row.parameterId) return null;
  const parameter = { _id: row.parameterId, organization_id: row.parameterOrganizationId, name: row.parameterName, key: row.parameterKey };
  if (row.parameterHistoryAvailable) Object.assign(parameter, { description: row.parameterDescription, order: row.parameterOrder,
    scheme_abbr: row.parameterSchemeAbbreviation, lab_id: row.parameterLaboratoryId });
  if (row.parameterHistoryAvailable && customFields !== undefined) parameter.project_field_data = customFields;
  return parameter;
}

// The caller supplies metadata captured for the row's actual parameter. A
// missing record means the configured title remains literal, including dots.
export function resolveParameterTitle(title, parameter, fallback = '') {
  if (!parameter) return title ?? fallback;
  if (!title) return fallback;
  if (String(title).includes('.')) {
    const fieldKey = String(title).split('.').at(-1);
    const customValue = own(own(parameter, 'project_field_data'), fieldKey);
    return own(customValue, 'display_value') ?? own(parameter, title) ?? fallback;
  }
  return own(parameter, title) ?? title ?? fallback;
}

// This is LegacyHtml's display conversion. Product's meaningful-value adapter
// has different blank/false semantics and must not replace this conversion.
export function stringifyTitleValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(stringifyTitleValue).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const display = own(value, 'display_value');
    if (display != null) return stringifyTitleValue(display);
    const stored = own(value, 'value');
    if (stored != null) return stringifyTitleValue(stored);
    try { return JSON.stringify(value); }
    catch { return String(value); }
  }
  return String(value);
}

// Vertical Text is a literal React child in the source: booleans are blank,
// numbers remain visible, and arrays have no added separators. An object must
// receive a safe literal representation instead of crashing the whole report.
export function verticalTitleValue(value) {
  if (Array.isArray(value)) return value.map(verticalTitleValue);
  return value !== null && typeof value === 'object' ? stringifyTitleValue(value) : value;
}
