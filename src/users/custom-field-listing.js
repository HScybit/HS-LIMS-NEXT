import { HttpError } from '../auth/errors.js';
import { customFieldSearchValue } from '../custom-fields/listing-values.js';

// OFFSET 0 keeps the current-head lookup ahead of matching; otherwise PostgreSQL can scan all historical revisions first.
export const userListingCaptures = `listing_current_values AS MATERIALIZED (
  SELECT head.organization_id,head.subject_user_id,head.revision,custom.field_id,custom.field_revision,
    custom.display_kind,custom.display_text,custom.display_number,custom.display_boolean
  FROM user_field_capture_heads head CROSS JOIN LATERAL (
    SELECT field_id,field_revision,display_kind,display_text,display_number,display_boolean
    FROM user_version_custom_fields
    WHERE organization_id=$1 AND subject_user_id=head.subject_user_id AND revision=head.revision OFFSET 0
  ) custom WHERE head.organization_id=$1 AND head.revision>0
), listing_captures AS MATERIALIZED (
  SELECT custom.organization_id,custom.subject_user_id,custom.revision,custom.field_id,definition.key,
    custom.display_kind,custom.display_text,custom.display_number,custom.display_boolean
  FROM listing_current_values custom JOIN listing_definitions definition ON definition.organization_id=custom.organization_id
    AND definition.field_id=custom.field_id AND definition.revision=custom.field_revision)`;

export function userCustomFieldMatch(bind, fieldKeys, value) {
  const keys = bind(fieldKeys); const search = customFieldSearchValue(value); const pattern = bind(search.pattern);
  const display = [`custom.display_text ILIKE ${pattern}`]; const raw = [`item.raw_text ILIKE ${pattern}`];
  if (search.number !== null) { const number = bind(search.number); display.push(`custom.display_number=${number}::double precision`); raw.push(`item.raw_number=${number}::double precision`); }
  if (search.boolean !== null) { const boolean = bind(search.boolean); display.push(`custom.display_boolean=${boolean}::boolean`); raw.push(`item.raw_boolean=${boolean}::boolean`); }
  return `EXISTS (SELECT 1 FROM listing_captures custom
    WHERE custom.organization_id=person.organization_id AND custom.subject_user_id=person.id AND custom.key=ANY(${keys}::text[])
      AND (${display.join(' OR ')} OR EXISTS (SELECT 1 FROM user_version_custom_field_values item
        WHERE item.organization_id=custom.organization_id AND item.subject_user_id=custom.subject_user_id AND item.revision=custom.revision AND item.field_id=custom.field_id
          AND (${raw.join(' OR ')}))))`;
}

export function userCustomFieldSortJoin(bind, key) {
  // Filter once before the directory join; rescanning all configured keys for every member is much more expensive.
  return `LEFT JOIN (WITH sort_values AS MATERIALIZED (
    SELECT custom.organization_id,custom.subject_user_id,custom.display_kind AS field_sort_kind,custom.display_text AS field_sort_text,
      custom.display_number AS field_sort_number,custom.display_boolean AS field_sort_boolean
    FROM listing_captures custom WHERE custom.key=${bind(key)}
  ) SELECT * FROM sort_values
  ) ordering_field ON ordering_field.organization_id=person.organization_id AND ordering_field.subject_user_id=person.id`;
}

export function userCustomFieldOrder(alias, direction) {
  return `CASE ${alias}.field_sort_kind WHEN 'number' THEN 1 WHEN 'text' THEN 2 WHEN 'boolean' THEN 3 ELSE 0 END ${direction},
    ${alias}.field_sort_number ${direction},${alias}.field_sort_text COLLATE "C" ${direction},${alias}.field_sort_boolean ${direction}`;
}

export async function loadUserListingValues(client, identity, rows, definitions) {
  const visible = new Map(definitions.filter(field => field.showInList).map(field => [field.key, field]));
  if (!rows.length || !visible.size) return rows;
  // Preserve the same current-head boundary for the requested page, including members with no recorded capture.
  const fields = (await client.query(`WITH page_fields AS MATERIALIZED (SELECT field.*
    FROM unnest($2::uuid[]) requested(id) JOIN user_field_capture_heads head ON head.organization_id=$1 AND head.subject_user_id=requested.id
    CROSS JOIN LATERAL (SELECT organization_id,subject_user_id,revision,field_id,field_revision,position,is_array,value_count,
        display_kind,display_text,display_number,display_boolean FROM user_version_custom_fields
      WHERE organization_id=$1 AND subject_user_id=head.subject_user_id AND revision=head.revision OFFSET 0) field WHERE head.revision>0)
    SELECT field.subject_user_id AS "recordId",field.revision,field.field_id AS "fieldId",definition.key,
      field.is_array AS "isArray",field.value_count AS "valueCount",field.display_kind AS "displayKind",
      field.display_text AS "displayText",field.display_number AS "displayNumber",field.display_boolean AS "displayBoolean"
    FROM page_fields field
    JOIN user_custom_field_versions definition ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE definition.key=ANY($3::text[]) ORDER BY field.subject_user_id,field.position`,
  [identity.organization_id, rows.map(row => row.id), [...visible.keys()]])).rows;
  const byRecord = new Map(rows.map(row => [row.id, new Map()])); const dates = new Map();
  const incomplete = () => new HttpError(409, 'incomplete_user_custom_fields', 'User Custom Field history is incomplete.');
  for (const field of fields) {
    const definition = visible.get(field.key); const record = byRecord.get(field.recordId);
    if (!definition || !record || record.has(field.key) || !['text', 'number', 'boolean'].includes(field.displayKind)) throw incomplete();
    const displayValue = field.displayKind === 'number' ? field.displayNumber : field.displayKind === 'boolean' ? field.displayBoolean : field.displayText;
    const entry = { displayValue }; record.set(field.key, entry);
    if (['date', 'date_time'].includes(definition.fieldType)) dates.set(`${field.recordId}:${field.fieldId}`, { ...field, entry, items: [] });
  }
  if (dates.size) {
    const requested = [...dates.values()];
    const items = (await client.query(`SELECT item.subject_user_id AS "recordId",item.field_id AS "fieldId",item.position,
        item.raw_kind AS kind,item.raw_text AS text,item.raw_number AS number,item.raw_boolean AS boolean
      FROM unnest($2::uuid[],$3::integer[],$4::uuid[]) requested(subject_user_id,revision,field_id)
      JOIN user_version_custom_field_values item ON item.organization_id=$1 AND item.subject_user_id=requested.subject_user_id
        AND item.revision=requested.revision AND item.field_id=requested.field_id
      ORDER BY item.subject_user_id,item.field_id,item.position`,
    [identity.organization_id, requested.map(field => field.recordId), requested.map(field => field.revision), requested.map(field => field.fieldId)])).rows;
    for (const item of items) {
      const field = dates.get(`${item.recordId}:${item.fieldId}`); const value = item[item.kind];
      if (!field || item.position !== field.items.length || !['text', 'number', 'boolean'].includes(item.kind)
        || typeof value !== (item.kind === 'text' ? 'string' : item.kind) || item.kind === 'number' && !Number.isFinite(value)) throw incomplete();
      field.items.push(value);
    }
    for (const field of dates.values()) {
      if (field.items.length !== field.valueCount || !field.isArray && field.valueCount !== 1) throw incomplete();
      field.entry.value = field.isArray ? field.items : field.items[0];
    }
  }
  return rows.map(row => ({ ...row, customFields: Object.fromEntries(byRecord.get(row.id)) }));
}
