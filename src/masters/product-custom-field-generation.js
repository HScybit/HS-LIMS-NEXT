import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text, uuid, requirePermission } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldFormDisplayValue, customFieldNeedsGeneration } from '../custom-fields/form-values.js';
import { customFieldTimeZone, customFieldDateDisplayInZone } from '../custom-fields/server-dates.js';
import { schemeTokens } from '../custom-fields/product-generation.js';
import { runProductGeneration } from '../custom-fields/product-generation-runner.js';
import { productCustomFields } from './custom-fields.js';

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
  const fields = await productCustomFields(client, identity);
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (fields.length !== command.customFields.length || command.customFields.some((item) => byId.get(item.fieldId)?.revision !== item.fieldRevision)) {
    throw new HttpError(409, 'product_custom_fields_changed', 'Custom Fields changed. Reload before generating.');
  }
  if (command.fieldId && !byId.get(command.fieldId)?.scheme) throw new HttpError(400, 'invalid_scheme', 'Select a Custom Field with a scheme.');
  const hasDates = fields.some((field) => ['date', 'date_time'].includes(field.fieldType));
  if (hasDates) customFieldTimeZone(command.timeZone);
  else if (command.timeZone !== null) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  if (command.productId && !(await client.query('SELECT id FROM products WHERE organization_id=$1 AND id=$2 AND active', [identity.organization_id, command.productId])).rowCount) {
    throw new HttpError(404, 'product_not_found', 'Product was not found.');
  }
  const values = Object.fromEntries(command.customFields.map((field) => [field.fieldId, field.value]));
  const mode = command.productId ? 'edit' : 'create';
  const selected = fields.filter((field) => command.fieldId ? field.id === command.fieldId : customFieldNeedsGeneration(field, mode, values[field.id]));
  if (!selected.length) return { values: [] };
  const tokens = new Set(selected.flatMap((field) => schemeTokens(field.scheme)));
  const context = (await client.query('SELECT * FROM masters_product_scheme_context($1,$2)',
    [['total_counter', 'nabl_counter'].some((token) => tokens.has(token)), ['samples_counter', 'sample_category_counter'].some((token) => tokens.has(token))])).rows[0];
  if (!context) throw new HttpError(403, 'forbidden', 'You cannot generate Product fields.');
  const doc = { ...command.product, _id: command.productId ?? undefined, __scheme_collname: 'Product', organization_id: identity.organization_id,
    project_field_data: Object.fromEntries(fields.map((field) => [field.key, { key: field.key, name: field.label, type: field.fieldType,
      value: values[field.id], display_value: customFieldFormDisplayValue(values[field.id], field, [], (value, definition) => customFieldDateDisplayInZone(value, definition, command.timeZone)),
      ...(field.scheme ? { scheme: field.scheme } : {}), ...(field.splitter ? { splitter: field.splitter } : {}),
      ...(field.paddedNumber == null ? {} : { padded_number: field.paddedNumber }),
      ...(field.startFrom == null || field.startFrom === '' ? {} : { start_from: field.startFrom }),
      ...(field.dateFormat ? { date_format: field.dateFormat } : {}), ...(field.datetimeFormat ? { datetime_format: field.datetimeFormat } : {}),
      ...(field.fieldType === 'multi_user_select' ? { is_multi_user_select: true } : {}),
    }])) };
  const now = new Date();
  const clock = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), timestamp: now.getTime() };
  const readPage = async (fieldId, cursor) => {
    // Search current, active heads in source creation/update order. Text timestamps preserve PostgreSQL microseconds in the cursor.
    // Fetch at most 500 candidates and an 8 MiB page (or one larger field); no value is truncated to fit a page.
    return (await client.query(`WITH candidates AS MATERIALIZED (
      SELECT product.id,product.created_at,product.updated_at,field.display_text
      FROM products product JOIN product_version_custom_fields field
        ON field.organization_id=product.organization_id AND field.product_id=product.id AND field.revision=product.revision
      WHERE product.organization_id=$1 AND field.field_id=$2 AND product.active AND field.display_kind='text'
        AND ($3::uuid IS NULL OR product.id<>$3) AND ($4::timestamptz IS NULL OR (product.created_at,product.updated_at,product.id)<($4::timestamptz,$5::timestamptz,$6::uuid))
      ORDER BY product.created_at DESC,product.updated_at DESC,product.id DESC LIMIT 500
    ), budget AS (
      SELECT *,sum(octet_length(display_text)) OVER (ORDER BY created_at DESC,updated_at DESC,id DESC) AS bytes,
        row_number() OVER (ORDER BY created_at DESC,updated_at DESC,id DESC) AS position FROM candidates
    ) SELECT id AS "productId",created_at::text AS "createdAt",updated_at::text AS "updatedAt",display_text AS value
      FROM budget WHERE bytes<=8388608 OR position=1 ORDER BY created_at DESC,updated_at DESC,id DESC`,
    [identity.organization_id, fieldId, command.productId, cursor?.createdAt ?? null, cursor?.updatedAt ?? null, cursor?.productId ?? null])).rows;
  };
  return { values: await runProductGeneration({ fields, values, doc, settings: context, counts: { products: context.productCount, samples: context.sampleCount },
    clock, timeZone: command.timeZone, fieldId: command.fieldId, mode }, readPage) };
}
