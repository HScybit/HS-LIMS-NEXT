import { HttpError } from '../auth/errors.js';

// attrName is a closed source selection. The separate configuration `attr`
// does not participate in this widget's lookup, nor does its Default Value.
export const sampleLineAttributes = Object.freeze([
  { value: 'custom_category', label: 'Category', property: 'categoryName' },
  { value: 'custom_product', label: 'Product', property: 'productName' },
  { value: 'custom_description', label: 'Description', property: 'description' },
  { value: 'custom_sample_quantity', label: 'Sample Quantity', property: 'quantity' },
  { value: 'custom_sample_size', label: 'Sample Size', property: 'sampleSize' },
  { value: 'custom_quality', label: 'Quality', property: 'quality' },
  { value: 'custom_indentification_mark', label: 'Identification Mark', property: 'identificationMark' },
  { value: 'custom_condition', label: 'Condition', property: 'receivedCondition' },
]);

export const MAX_SAMPLE_LINE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export function sampleLineSelection(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_context_field', 'Select a supported line-item attribute.');
  const selected = value.trim();
  if (!selected || selected === '-1') return null;
  if (!sampleLineAttributes.some((attribute) => attribute.value === selected)) throw new HttpError(400, 'invalid_context_field', 'Select a supported line-item attribute.');
  return selected;
}

export function hasSampleLineWidget(model) {
  return Object.values(model.fieldsById).some((field) => field.widget === 'sample_line_item_data_widget');
}

export function sampleLineValue(field, lineItem) {
  const property = sampleLineAttributes.find((attribute) => attribute.value === field.sourceField)?.property;
  const value = property && lineItem && Object.hasOwn(lineItem, property) ? lineItem[property] : null;
  // The source helper tests truthiness before displaying its scalar. Preserve
  // whitespace and the string "0"; never coerce PostgreSQL numeric text to JS.
  return value && ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
}

export function sampleLineBytes(field, lineItem) {
  return encoder.encode(sampleLineValue(field, lineItem)).byteLength;
}

export function assertSampleLineBytes(bytes) {
  if (bytes > MAX_SAMPLE_LINE_BYTES) throw new HttpError(422, 'sample_line_size_limit', 'The repeated line-item values exceed the supported document size. Reduce the template or repeat count.');
  return bytes;
}

export function assertSampleLineCounts(counts, lineItem) {
  return assertSampleLineBytes(sampleLineCountsBytes(counts, lineItem));
}

export function sampleLineCountsBytes(counts, lineItem) {
  return Object.entries(counts).reduce((bytes, [sourceField, count]) => bytes + sampleLineBytes({ sourceField }, lineItem) * count, 0);
}

export function assertSampleLineCaptureSize(model, occurrences, lineItem) {
  const counts = new Map();
  for (const occurrence of occurrences) counts.set(occurrence.groupId ?? null, (counts.get(occurrence.groupId ?? null) ?? 0) + 1);
  let bytes = 0;
  for (const field of Object.values(model.fieldsById)) if (field.widget === 'sample_line_item_data_widget') {
    bytes += sampleLineBytes(field, lineItem) * (counts.get(field.repeatGroupId ?? null) ?? 0);
  }
  return assertSampleLineBytes(bytes);
}
