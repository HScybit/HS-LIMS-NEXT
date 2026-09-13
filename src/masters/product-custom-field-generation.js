import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text, uuid, requirePermission } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone } from '../custom-fields/server-dates.js';
import { generateMasterCustomFields } from './master-custom-field-generation.js';

export function productGenerationInput(input) {
  fieldsOnly(input, ['productId', 'product', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.product, ['name', 'description', 'abbreviation', 'key', 'jobTemplateId', 'tagIds']);
  const product = input.product;
  const tags = product.tagIds ?? [];
  if (!Array.isArray(tags) || tags.length > 500) throw new HttpError(400, 'invalid_product_tags', 'Select at most 500 tags.');
  const values = { name: text(product.name, 'Name', 200, { optional: true }), description: text(product.description, 'Description', 16000, { optional: true }),
    abbr: product.abbreviation == null ? null : text(product.abbreviation, 'Abbreviation', 64, { optional: true }),
    key: text(product.key, 'Unique Key', 64, { optional: true }),
    job_template_id: product.jobTemplateId == null || product.jobTemplateId === '' ? null : uuid(product.jobTemplateId, 'Job Template').toLowerCase(),
    tags: tags.map((id) => uuid(id, 'Tag').toLowerCase()) };
  if (Object.values(values).some((value) => typeof value === 'string' && (!value.isWellFormed() || value.includes('\0')))) {
    throw new HttpError(400, 'invalid_input', 'Product text is invalid.');
  }
  return { productId: input.productId == null ? null : uuid(input.productId, 'Product').toLowerCase(),
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(), product: values,
    customFields: customFieldValuesInput(input.customFields),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateProductCustomFields(client, identity, input) {
  requirePermission(identity, 'masters.manage');
  const command = productGenerationInput(input);
  return generateMasterCustomFields('product', client, identity, { ...command, id: command.productId, doc: command.product });
}
