import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { customFieldFormDisplayValue, customFieldValidationError } from '../custom-fields/form-values.js';
import { customFieldTimeZone, customFieldTimeZoneDataVersion, customFieldDateParserVersion,
  parseCustomFieldDateInZone, customFieldDateDisplayInZone } from '../custom-fields/server-dates.js';

const stores = Object.freeze({
  product: Object.freeze({ label: 'Product', fieldTable: 'product_version_custom_fields', valueTable: 'product_version_custom_field_values', idColumn: 'product_id' }),
  parameter: Object.freeze({ label: 'Parameter', fieldTable: 'parameter_version_custom_fields', valueTable: 'parameter_version_custom_field_values', idColumn: 'parameter_id' }),
  user: Object.freeze({ label: 'User', fieldTable: 'user_version_custom_fields', valueTable: 'user_version_custom_field_values', idColumn: 'subject_user_id',
    definitionTable: 'user_custom_field_versions', optionTable: 'user_custom_field_version_options', attachmentTable: 'user_custom_field_attachments',
    userTable: 'user_directory', userIdColumn: 'id', frozenUsers: true, attachmentPath: '/api/users/custom-fields/attachments' }),
});
function storeFor(kind) {
  if (!Object.hasOwn(stores, kind)) throw new TypeError('Unsupported Custom Field master.');
  return stores[kind];
}

const dateField = (field) => ['date', 'date_time'].includes(field.fieldType);
function primitive(record, prefix, kind) {
  switch (record[`${prefix}Kind`]) {
    case 'text': return record[`${prefix}Text`];
    case 'number': return record[`${prefix}Number`];
    case 'boolean': return record[`${prefix}Boolean`];
    default: throw new HttpError(409, `incomplete_${kind}_custom_fields`, `${storeFor(kind).label} Custom Field history is incomplete.`);
  }
}
function typedPrimitive(value) {
  return { kind: typeof value === 'string' ? 'text' : typeof value, text: typeof value === 'string' ? value : null,
    number: typeof value === 'number' ? value : null, boolean: typeof value === 'boolean' ? value : null };
}

export async function loadMasterCustomFieldValues(kind, client, identity, masterId, revision, expectedCount) {
  const store = storeFor(kind);
  if (!expectedCount) return [];
  const fields = (await client.query(`SELECT field.field_id AS "fieldId",field.field_revision AS "fieldRevision",field.field_type AS "fieldType",
    field.position,field.is_array AS "isArray",field.value_count AS "valueCount",field.display_kind AS "displayKind",
    field.display_text AS "displayText",field.display_number AS "displayNumber",field.display_boolean AS "displayBoolean",
    field.time_zone AS "timeZone",field.time_zone_data_version AS "timeZoneDataVersion",field.date_parser_version AS "dateParserVersion",
    definition.key,definition.label FROM ${store.fieldTable} field JOIN ${store.definitionTable ?? 'custom_field_versions'} definition
      ON definition.organization_id=field.organization_id AND definition.field_id=field.field_id AND definition.revision=field.field_revision
    WHERE field.organization_id=$1 AND field.${store.idColumn}=$2 AND field.revision=$3 ORDER BY field.position LIMIT 501`,
  [identity.organization_id, masterId, revision])).rows;
  const incomplete = () => new HttpError(409, `incomplete_${kind}_custom_fields`, `${storeFor(kind).label} Custom Field history is incomplete.`);
  if (fields.length !== expectedCount || fields.some((field, index) => field.position !== index)) throw incomplete();
  const items = (await client.query(`SELECT item.field_id AS "fieldId",item.position,item.raw_kind AS "rawKind",item.raw_text AS "rawText",
    item.raw_number AS "rawNumber",item.raw_boolean AS "rawBoolean",item.interpretation_state AS "interpretationState",
    item.option_id AS "optionId",item.option_revision AS "optionRevision",choice.label AS "optionLabel",item.user_id AS "userId",
    ${store.frozenUsers ? 'item.user_name AS "userName",item.user_username AS "userUsername"' : 'person.display_name AS "userName"'},
    item.attachment_id AS "attachmentId",file.original_name AS "fileName",file.media_type AS "fileMediaType"
    FROM ${store.valueTable} item
    LEFT JOIN ${store.optionTable ?? 'custom_field_version_options'} choice ON choice.organization_id=item.organization_id AND choice.field_id=item.field_id
      AND choice.revision=item.option_revision AND choice.id=item.option_id
    ${store.frozenUsers ? '' : 'LEFT JOIN method_access_user_labels person ON person.organization_id=item.organization_id AND person.user_id=item.user_id'}
    LEFT JOIN ${store.attachmentTable ?? 'custom_field_attachments'} file ON file.organization_id=item.organization_id AND file.id=item.attachment_id
    WHERE item.organization_id=$1 AND item.${store.idColumn}=$2 AND item.revision=$3 ORDER BY item.field_id,item.position LIMIT 5001`,
  [identity.organization_id, masterId, revision])).rows;
  if (items.length > 5000) throw incomplete();
  const byId = new Map(fields.map((field) => [field.fieldId, { ...field, items: [] }]));
  for (const item of items) {
    const field = byId.get(item.fieldId);
    if (!field || item.position !== field.items.length) throw incomplete();
    field.items.push({ value: primitive(item, 'raw', kind), interpretationState: item.interpretationState,
      optionId: item.optionId, optionRevision: item.optionRevision, optionLabel: item.optionLabel,
      userId: item.userId, userName: item.userName, ...(store.frozenUsers ? { userUsername: item.userUsername } : {}), attachmentId: item.attachmentId,
      attachment: item.attachmentId ? { id: item.attachmentId, originalName: item.fileName, mediaType: item.fileMediaType,
        url: `${store.attachmentPath ?? '/api/custom-fields/attachments'}/${item.attachmentId}` } : null });
  }
  return [...byId.values()].map((field) => {
    if (field.items.length !== field.valueCount) throw incomplete();
    return { fieldId: field.fieldId, fieldRevision: field.fieldRevision, fieldType: field.fieldType, key: field.key, label: field.label,
      value: field.isArray ? field.items.map((item) => item.value) : field.items[0].value,
      displayValue: primitive(field, 'display', kind), timeZone: field.timeZone, timeZoneDataVersion: field.timeZoneDataVersion,
      dateParserVersion: field.dateParserVersion, items: field.items };
  });
}

function postgresDate(value, includeTime = false) {
  const year = value.year(); const era = year > 0 ? '' : ' BC';
  const day = String(year > 0 ? year : 1 - year).padStart(4, '0') + value.format('-MM-DD');
  return day + (includeTime ? value.format(' HH:mm:ss.SSS') + '+00' : '') + era;
}

// Entries have already passed customFieldValuesInput at the owning master command boundary.
export async function prepareMasterCustomFieldValues(kind, client, identity, { definitions, entries, timeZone, previousFields = [] }) {
  const store = storeFor(kind);
  if (entries === undefined) {
    if (definitions.length) throw new HttpError(409, `${kind}_custom_fields_changed`, 'Custom Fields changed. Reload before saving.');
    if (timeZone !== null && timeZone !== undefined) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
    return { provided: false, count: previousFields.length, fields: [], items: [] };
  }
  const definitionsById = new Map(definitions.map((field) => [field.id, field]));
  if (entries.length !== definitions.length || entries.some((entry) => definitionsById.get(entry.fieldId)?.revision !== entry.fieldRevision)) {
    throw new HttpError(409, `${kind}_custom_fields_changed`, 'Custom Fields changed. Reload before saving.');
  }
  const hasDates = definitions.some(dateField);
  const zone = hasDates ? customFieldTimeZone(timeZone) : null;
  if (!hasDates && timeZone !== null && timeZone !== undefined) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  const previousById = new Map(previousFields.map((field) => [field.fieldId, field]));
  const previousByKey = kind === 'user' ? new Map(previousFields.map((field) => [field.key, field])) : null;
  const userIds = new Set(); const attachmentIds = new Set(); const fields = []; const items = [];
  for (const [position, entry] of entries.entries()) {
    const field = definitionsById.get(entry.fieldId); const validation = customFieldValidationError(field, entry.value);
    if (validation) throw new HttpError(400, 'invalid_custom_field_value', `${field.label}: ${validation}`);
    const options = new Map(field.options.map((option) => [option.key, option]));
    const previousField = kind === 'user' ? previousByKey.get(field.key) : previousById.get(field.id);
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    const display = typedPrimitive(customFieldFormDisplayValue(entry.value, field, [], (value, definition) => customFieldDateDisplayInZone(value, definition, zone)));
    fields.push({ fieldId: field.id, fieldRevision: field.revision, fieldType: field.fieldType, position, isArray: Array.isArray(entry.value), valueCount: values.length,
      displayKind: display.kind, displayText: display.text, displayNumber: display.number, displayBoolean: display.boolean,
      timeZone: dateField(field) ? zone : null, timeZoneDataVersion: dateField(field) ? customFieldTimeZoneDataVersion : null,
      dateParserVersion: dateField(field) ? customFieldDateParserVersion : null });
    for (const [itemPosition, value] of values.entries()) {
      const raw = typedPrimitive(value);
      const item = { fieldId: field.id, position: itemPosition, rawKind: raw.kind, rawText: raw.text, rawNumber: raw.number, rawBoolean: raw.boolean,
        rawNumberText: raw.kind === 'number' ? String(value) : null, interpretationState: value === '' ? 'empty' : 'valid',
        parsedNumber: null, parsedBoolean: null, parsedDate: null, parsedTimestamp: null, optionId: null, optionRevision: null, userId: null, attachmentId: null };
      if (value !== '') {
        if (field.fieldType === 'number') {
          const number = Number(value); item.parsedNumber = Number.isFinite(number) ? number : null;
          if (item.parsedNumber === null) item.interpretationState = 'invalid';
        } else if (field.fieldType === 'checkbox') item.parsedBoolean = Boolean(value);
        else if (dateField(field)) {
          const parsed = parseCustomFieldDateInZone(value, field, zone);
          if (!parsed) item.interpretationState = 'invalid';
          else {
            item.parsedDate = field.fieldType === 'date' ? postgresDate(parsed) : null;
            item.parsedTimestamp = postgresDate(parsed.clone().utc(), true);
          }
        } else if (field.fieldType === 'select') {
          const option = options.get(String(value));
          const previous = !option && previousField?.items.find((item) => item.value === value && (kind === 'user' || item.optionId && item.optionRevision));
          if (!option && !previous) throw new HttpError(400, `invalid_${kind}_custom_field_option`, `${field.label}: Select an available option.`);
          if (option || previousField.fieldId === field.id && previous.optionId && previous.optionRevision) {
            item.optionId = option?.id ?? previous.optionId; item.optionRevision = option ? field.revision : previous.optionRevision;
          } else {
            // A reused user key can retain raw text without claiming an option belonging to another definition.
            item.interpretationState = 'invalid';
          }
        } else if (field.fieldType === 'multi_user_select') {
          item.userId = uuid(value, field.label).toLowerCase(); userIds.add(item.userId);
        } else if (field.fieldType === 'attachment') {
          item.attachmentId = uuid(value, field.label).toLowerCase(); attachmentIds.add(item.attachmentId);
        } else if (field.fieldType === 'lookup') throw new HttpError(400, `invalid_${kind}_custom_field_lookup`, `${field.label}: This lookup has no configured source.`);
      }
      items.push(item);
    }
  }
  if (userIds.size) {
    const users = (await client.query(`SELECT ${store.userIdColumn ?? 'user_id'} AS user_id FROM ${store.userTable ?? 'method_access_user_labels'}
      WHERE organization_id=$1 AND ${store.userIdColumn ?? 'user_id'}=ANY($2::uuid[])`, [identity.organization_id, [...userIds]])).rows;
    if (users.length !== userIds.size) throw new HttpError(400, `invalid_${kind}_custom_field_user`, 'Select users in this organization.');
  }
  if (attachmentIds.size) {
    const files = (await client.query(kind === 'user'
      ? `SELECT file.id,file.field_id,uploaded.key AS upload_key FROM user_custom_field_attachments file
        JOIN user_custom_field_versions uploaded ON uploaded.organization_id=file.organization_id
          AND uploaded.field_id=file.field_id AND uploaded.revision=file.field_revision
        WHERE file.organization_id=$1 AND file.id=ANY($2::uuid[])`
      : `SELECT id,field_id FROM ${store.attachmentTable ?? 'custom_field_attachments'}
        WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [identity.organization_id, [...attachmentIds]])).rows;
    const byId = new Map(files.map((file) => [file.id, file]));
    if (items.some((item) => {
      if (!item.attachmentId) return false;
      const file = byId.get(item.attachmentId); const key = definitionsById.get(item.fieldId).key;
      const matchingUploadKey = kind === 'user' && typeof file?.upload_key === 'string' && file.upload_key === key;
      const retained = kind === 'user' && previousByKey.get(key)?.items.some(previous => previous.attachmentId === item.attachmentId);
      return !file || file.field_id !== item.fieldId && !matchingUploadKey && !retained;
    })) {
      throw new HttpError(400, `invalid_${kind}_custom_field_attachment`, 'Select attachments belonging to these Custom Fields.');
    }
  }
  return { provided: true, count: fields.length, fields, items };
}

export async function appendMasterCustomFieldValues(kind, client, identity, masterId, revision, capture) {
  const store = storeFor(kind);
  if (!capture.provided || !capture.fields.length) return;
  const fieldColumns = { fieldId: ['field_id', 'uuid'], fieldRevision: ['field_revision', 'integer'], fieldType: ['field_type', 'text'], position: ['position', 'integer'],
    isArray: ['is_array', 'boolean'], valueCount: ['value_count', 'integer'], displayKind: ['display_kind', 'text'], displayText: ['display_text', 'text'],
    displayNumber: ['display_number', 'double precision'], displayBoolean: ['display_boolean', 'boolean'], timeZone: ['time_zone', 'text'],
    timeZoneDataVersion: ['time_zone_data_version', 'text'], dateParserVersion: ['date_parser_version', 'text'] };
  const fields = Object.entries(fieldColumns);
  await client.query(`INSERT INTO ${store.fieldTable}(organization_id,${store.idColumn},revision,${fields.map(([, [column]]) => column).join(',')})
    SELECT $1,$2,$3,field.* FROM unnest(${fields.map(([, [, type]], index) => `$${index + 4}::${type}[]`).join(',')}) AS field`,
  [identity.organization_id, masterId, revision, ...fields.map(([key]) => capture.fields.map((field) => field[key]))]);
  if (!capture.items.length) return;
  const itemColumns = { fieldId: ['field_id', 'uuid'], position: ['position', 'integer'], rawKind: ['raw_kind', 'text'], rawText: ['raw_text', 'text'],
    rawNumber: ['raw_number', 'double precision'], rawBoolean: ['raw_boolean', 'boolean'], rawNumberText: ['raw_number_text', 'text'], interpretationState: ['interpretation_state', 'text'],
    parsedNumber: ['parsed_number', 'double precision'], parsedBoolean: ['parsed_boolean', 'boolean'], parsedDate: ['parsed_date', 'text'], parsedTimestamp: ['parsed_timestamp', 'text'],
    optionId: ['option_id', 'uuid'], optionRevision: ['option_revision', 'integer'], userId: ['user_id', 'uuid'], attachmentId: ['attachment_id', 'uuid'] };
  const columns = Object.entries(itemColumns);
  const dateFits = `(item.parsed_timestamp IS NULL OR (pg_input_is_valid(item.parsed_timestamp,'timestamp with time zone')
    AND (item.parsed_date IS NULL OR pg_input_is_valid(item.parsed_date,'date'))))`;
  const selected = columns.map(([, [column]]) => column === 'interpretation_state'
    ? `CASE WHEN ${dateFits} THEN item.interpretation_state ELSE 'out_of_range' END`
    : ['parsed_date', 'parsed_timestamp'].includes(column)
      ? `CASE WHEN ${dateFits} THEN item.${column}::${column === 'parsed_date' ? 'date' : 'timestamp with time zone'} END`
      : `item.${column}`);
  await client.query(`INSERT INTO ${store.valueTable}(organization_id,${store.idColumn},revision,${columns.map(([, [column]]) => column).join(',')})
    SELECT $1,$2,$3,${selected.join(',')} FROM unnest(${columns.map(([, [, type]], index) => `$${index + 4}::${type}[]`).join(',')}) AS item(${columns.map(([, [column]]) => column).join(',')})`,
  [identity.organization_id, masterId, revision, ...columns.map(([key]) => capture.items.map((item) => item[key]))]);
}
