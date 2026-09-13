import { HttpError } from '../auth/errors.js';
import { customFieldSearchValue } from '../custom-fields/listing-values.js';

const stores = Object.freeze({
  product: Object.freeze({ label: 'Product', alias: 'product', fieldTable: 'product_version_custom_fields', valueTable: 'product_version_custom_field_values', idColumn: 'product_id' }),
  parameter: Object.freeze({ label: 'Parameter', alias: 'parameter', fieldTable: 'parameter_version_custom_fields', valueTable: 'parameter_version_custom_field_values', idColumn: 'parameter_id' }),
});
function storeFor(kind) {
  if (!Object.hasOwn(stores, kind)) throw new TypeError('Unsupported Custom Field master.');
  return stores[kind];
}

export function masterCustomFieldMatch(kind, bind, fieldIds, value) {
  const store = storeFor(kind);
  const ids = bind(fieldIds); const search = customFieldSearchValue(value); const pattern = bind(search.pattern);
  const display = [`custom.display_text ILIKE ${pattern}`]; const raw = [`item.raw_text ILIKE ${pattern}`];
  if (search.number !== null) { const number = bind(search.number); display.push(`custom.display_number=${number}::double precision`); raw.push(`item.raw_number=${number}::double precision`); }
  if (search.boolean !== null) { const boolean = bind(search.boolean); display.push(`custom.display_boolean=${boolean}::boolean`); raw.push(`item.raw_boolean=${boolean}::boolean`); }
  return `EXISTS (SELECT 1 FROM ${store.fieldTable} custom WHERE custom.organization_id=${store.alias}.organization_id
    AND custom.${store.idColumn}=${store.alias}.id AND custom.revision=${store.alias}.revision AND custom.field_id=ANY(${ids}::uuid[])
    AND (${display.join(' OR ')} OR EXISTS (SELECT 1 FROM ${store.valueTable} item
      WHERE item.organization_id=custom.organization_id AND item.${store.idColumn}=custom.${store.idColumn} AND item.revision=custom.revision AND item.field_id=custom.field_id
      AND (${raw.join(' OR ')}))))`;
}

export async function loadMasterListingValues(kind, client, identity, rows, fields) {
  const store = storeFor(kind);
  const visible = fields.filter((field) => field.showInList);
  if (!rows.length || !visible.length) return rows;
  const captures = (await client.query(`SELECT field.${store.idColumn} AS "recordId",field.revision,field.field_id AS "fieldId",field.is_array AS "isArray",field.value_count AS "valueCount",
    field.display_kind AS "displayKind",field.display_text AS "displayText",field.display_number AS "displayNumber",field.display_boolean AS "displayBoolean"
    FROM unnest($2::uuid[],$3::integer[]) requested(${store.idColumn},revision) JOIN ${store.fieldTable} field
      ON field.organization_id=$1 AND field.${store.idColumn}=requested.${store.idColumn} AND field.revision=requested.revision
    WHERE field.field_id=ANY($4::uuid[]) ORDER BY field.${store.idColumn},field.position`,
  [identity.organization_id, rows.map((row) => row._id),rows.map((row) => row.revision),visible.map((field) => field.id)])).rows;
  const byRecord = new Map(rows.map((row) => [row._id,{ ...row,customFields: {} }]));
  const dates = new Set(visible.filter((field) => ['date','date_time'].includes(field.fieldType)).map((field) => field.id));
  const capturedDates = new Map();
  for (const field of captures) {
    const displayValue = field.displayKind === 'number' ? field.displayNumber : field.displayKind === 'boolean' ? field.displayBoolean : field.displayText;
    const entry = { displayValue };
    byRecord.get(field.recordId).customFields[field.fieldId] = entry;
    if (dates.has(field.fieldId)) capturedDates.set(`${field.recordId}:${field.fieldId}`,{ ...field,entry,items: [] });
  }
  if (capturedDates.size) {
    const items = (await client.query(`SELECT item.${store.idColumn} AS "recordId",item.field_id AS "fieldId",item.position,
      item.raw_kind AS kind,item.raw_text AS text,item.raw_number AS number,item.raw_boolean AS boolean
      FROM unnest($2::uuid[],$3::integer[]) requested(${store.idColumn},revision) JOIN ${store.valueTable} item
        ON item.organization_id=$1 AND item.${store.idColumn}=requested.${store.idColumn} AND item.revision=requested.revision
      WHERE item.field_id=ANY($4::uuid[]) ORDER BY item.${store.idColumn},item.field_id,item.position`,
    [identity.organization_id,rows.map((row) => row._id),rows.map((row) => row.revision),[...dates]])).rows;
    const incomplete = () => new HttpError(409,`incomplete_${kind}_custom_fields`,`${store.label} Custom Field history is incomplete.`);
    for (const item of items) {
      const field = capturedDates.get(`${item.recordId}:${item.fieldId}`);
      if (!field || item.position !== field.items.length || !['text','number','boolean'].includes(item.kind)) throw incomplete();
      field.items.push(item[item.kind]);
    }
    for (const field of capturedDates.values()) {
      if (field.items.length !== field.valueCount) throw incomplete();
      field.entry.value = field.isArray ? field.items : field.items[0];
    }
  }
  return [...byRecord.values()];
}
