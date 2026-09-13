import { HttpError } from '../auth/errors.js';
import { productCustomFieldSearchValue } from '../custom-fields/listing-values.js';

export function productCustomFieldMatch(bind, fieldIds, value) {
  const ids = bind(fieldIds); const search = productCustomFieldSearchValue(value); const pattern = bind(search.pattern);
  const display = [`custom.display_text ILIKE ${pattern}`]; const raw = [`item.raw_text ILIKE ${pattern}`];
  if (search.number !== null) { const number = bind(search.number); display.push(`custom.display_number=${number}::double precision`); raw.push(`item.raw_number=${number}::double precision`); }
  if (search.boolean !== null) { const boolean = bind(search.boolean); display.push(`custom.display_boolean=${boolean}::boolean`); raw.push(`item.raw_boolean=${boolean}::boolean`); }
  return `EXISTS (SELECT 1 FROM product_version_custom_fields custom WHERE custom.organization_id=product.organization_id
    AND custom.product_id=product.id AND custom.revision=product.revision AND custom.field_id=ANY(${ids}::uuid[])
    AND (${display.join(' OR ')} OR EXISTS (SELECT 1 FROM product_version_custom_field_values item
      WHERE item.organization_id=custom.organization_id AND item.product_id=custom.product_id AND item.revision=custom.revision AND item.field_id=custom.field_id
      AND (${raw.join(' OR ')}))))`;
}

export async function loadProductListingValues(client, identity, rows, fields) {
  const visible = fields.filter((field) => field.showInList);
  if (!rows.length || !visible.length) return rows;
  const captures = (await client.query(`SELECT field.product_id AS "productId",field.revision,field.field_id AS "fieldId",field.is_array AS "isArray",field.value_count AS "valueCount",
    field.display_kind AS "displayKind",field.display_text AS "displayText",field.display_number AS "displayNumber",field.display_boolean AS "displayBoolean"
    FROM unnest($2::uuid[],$3::integer[]) requested(product_id,revision) JOIN product_version_custom_fields field
      ON field.organization_id=$1 AND field.product_id=requested.product_id AND field.revision=requested.revision
    WHERE field.field_id=ANY($4::uuid[]) ORDER BY field.product_id,field.position`,
  [identity.organization_id, rows.map((row) => row._id),rows.map((row) => row.revision),visible.map((field) => field.id)])).rows;
  const byProduct = new Map(rows.map((row) => [row._id,{ ...row,customFields: {} }]));
  const dates = new Set(visible.filter((field) => ['date','date_time'].includes(field.fieldType)).map((field) => field.id));
  const capturedDates = new Map();
  for (const field of captures) {
    const displayValue = field.displayKind === 'number' ? field.displayNumber : field.displayKind === 'boolean' ? field.displayBoolean : field.displayText;
    const entry = { displayValue };
    byProduct.get(field.productId).customFields[field.fieldId] = entry;
    if (dates.has(field.fieldId)) capturedDates.set(`${field.productId}:${field.fieldId}`,{ ...field,entry,items: [] });
  }
  if (capturedDates.size) {
    const items = (await client.query(`SELECT item.product_id AS "productId",item.field_id AS "fieldId",item.position,
      item.raw_kind AS kind,item.raw_text AS text,item.raw_number AS number,item.raw_boolean AS boolean
      FROM unnest($2::uuid[],$3::integer[]) requested(product_id,revision) JOIN product_version_custom_field_values item
        ON item.organization_id=$1 AND item.product_id=requested.product_id AND item.revision=requested.revision
      WHERE item.field_id=ANY($4::uuid[]) ORDER BY item.product_id,item.field_id,item.position`,
    [identity.organization_id,rows.map((row) => row._id),rows.map((row) => row.revision),[...dates]])).rows;
    const incomplete = () => new HttpError(409,'incomplete_product_custom_fields','Product Custom Field history is incomplete.');
    for (const item of items) {
      const field = capturedDates.get(`${item.productId}:${item.fieldId}`);
      if (!field || item.position !== field.items.length || !['text','number','boolean'].includes(item.kind)) throw incomplete();
      field.items.push(item[item.kind]);
    }
    for (const field of capturedDates.values()) {
      if (field.items.length !== field.valueCount) throw incomplete();
      field.entry.value = field.isArray ? field.items : field.items[0];
    }
  }
  return [...byProduct.values()];
}
