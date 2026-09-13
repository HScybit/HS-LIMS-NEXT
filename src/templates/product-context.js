// Product-detail keys select explicit historical attributes, not arbitrary
// paths or prototype properties. Custom keys belong to the captured revision.
export const productDetailAttributes = Object.freeze({
  _id: 'id', name: 'name', description: 'description', key: 'code', abbr: 'abbreviation',
  job_template_id: 'jobTemplateId', tags: 'tagIds',
  organization_id: 'organizationId', user_id: 'createdBy', created_at: 'createdAt', updated_at: 'updatedAt',
});

const meaningful = (value) => value !== undefined && value !== null && String(value).trim() !== '';

export function productDetailText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(productDetailText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function productDetailCustomKey(identifier) {
  const key = String(identifier || '').trim();
  return key.startsWith('project_field__splitter__') ? key.split('__splitter__')[1] || '' : null;
}

export function productDetailSelector(identifier) {
  const key = String(identifier || '').trim(); const customKey = productDetailCustomKey(key);
  return customKey === null ? key : `project_field__splitter__${customKey}`;
}

export function productDetailProjection(product, selectors) {
  const values = Object.create(null);
  for (const key of [...Object.keys(productDetailAttributes), ...Object.keys(product.customFieldsByKey).map((key) => `project_field__splitter__${key}`)]) {
    if (!selectors.has(key)) continue;
    const value = productDetailValue(product, key);
    if (value !== '') values[key] = value;
  }
  return values;
}

export function productDetailValue(product, identifier) {
  const key = String(identifier || '').trim();
  if (!product || !key || key === '-1') return '';
  const fieldKey = productDetailCustomKey(key);
  if (fieldKey !== null) {
    const fields = product.customFieldsByKey;
    const field = fields && Object.hasOwn(fields, fieldKey) ? fields[fieldKey] : undefined;
    const value = meaningful(field?.displayValue) ? field.displayValue : meaningful(field?.value) ? field.value : '';
    return productDetailText(value);
  }
  if (!Object.hasOwn(productDetailAttributes, key)) return '';
  const attribute = productDetailAttributes[key];
  // Dates survive JSON transport as ISO text, while Meteor's widget renders
  // its Date objects through JSON.stringify, including the quotation marks.
  if (['createdAt', 'updatedAt'].includes(attribute)) return Object.hasOwn(product, attribute) && product[attribute] != null ? JSON.stringify(product[attribute]) : '';
  return Object.hasOwn(product, attribute) ? productDetailText(product[attribute]) : '';
}
