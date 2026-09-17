import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, requirePermission, text, uuid } from '../templates/input.js';
import { customFieldValuesInput } from '../custom-fields/value-input.js';
import { customFieldTimeZone, customFieldDateDisplayInZone } from '../custom-fields/server-dates.js';
import { customFieldFormDisplayValue, customFieldNeedsGeneration } from '../custom-fields/form-values.js';
import { schemeTokens } from '../custom-fields/product-generation.js';
import { runMasterGeneration } from '../custom-fields/product-generation-runner.js';
import { userCustomFields } from '../masters/custom-fields.js';
import { currentLookupSelections } from '../masters/master-custom-field-values.js';

export function userGenerationInput(input) {
  fieldsOnly(input, ['userId', 'user', 'customFields', 'customFieldTimeZone', 'fieldId']);
  fieldsOnly(input.user, ['displayName', 'email', 'username', 'phone', 'designation', 'canManagePeople',
    'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId']);
  const id = input.userId == null ? null : uuid(input.userId, 'User').toLowerCase();
  const user = input.user;
  // Generation receives the unfinished form, but never credentials or signature bytes.
  const doc = Object.fromEntries([
    ['displayName', 'name', 200], ['email', 'email', 320], ['username', 'username', 100],
    ['phone', 'contact_number', 50], ['designation', 'designation', 150],
  ].map(([key, source, limit]) => [source, text(user[key], key, limit, { optional: true })]));
  if (Object.values(doc).some(value => !value.isWellFormed() || value.includes('\0'))) {
    throw new HttpError(400, 'invalid_input', 'User text is invalid.');
  }
  doc.can_be_manager = user.canManagePeople === undefined ? false : bool(user.canManagePeople, 'Can be Manager');
  for (const [key, source] of [['businessUnitId', 'unit_id'], ['defaultRoleId', 'default_role'], ['laboratoryId', 'lab_id'], ['reportingManagerId', 'reporting_manager_id']]) {
    const value = user[key];
    if (key === 'reportingManagerId' && !id) {
      if (value !== undefined && value !== null && value !== '') throw new HttpError(400, 'invalid_input', 'Reporting Manager is available when editing a user.');
      continue;
    }
    doc[source] = value == null || value === '' ? '' : uuid(value, key).toLowerCase();
  }
  return { id, doc, customFields: customFieldValuesInput(input.customFields),
    fieldId: input.fieldId == null ? null : uuid(input.fieldId, 'Custom Field').toLowerCase(),
    timeZone: input.customFieldTimeZone == null ? null : customFieldTimeZone(input.customFieldTimeZone) };
}

export async function generateUserCustomFields(client, identity, input) {
  requirePermission(identity, 'users.manage');
  const command = userGenerationInput(input);
  const fields = await userCustomFields(client, identity);
  const byId = new Map(fields.map(field => [field.id, field]));
  if (fields.length !== command.customFields.length || command.customFields.some(item => byId.get(item.fieldId)?.revision !== item.fieldRevision)) {
    throw new HttpError(409, 'user_custom_fields_changed', 'Custom Fields changed. Reload before generating.');
  }
  if (command.fieldId && !byId.get(command.fieldId)?.scheme) throw new HttpError(400, 'invalid_scheme', 'Select a Custom Field with a scheme.');
  if (fields.some(field => ['date', 'date_time'].includes(field.fieldType))) customFieldTimeZone(command.timeZone);
  else if (command.timeZone !== null) throw new HttpError(400, 'invalid_custom_field_timezone', 'A Custom Field time zone requires captured date fields.');
  if (command.id && !(await client.query('SELECT subject_user_id FROM user_field_capture_heads WHERE organization_id=$1 AND subject_user_id=$2', [identity.organization_id, command.id])).rowCount) {
    throw new HttpError(404, 'user_not_found', 'User was not found.');
  }
  const values = Object.fromEntries(command.customFields.map(field => [field.fieldId, field.value]));
  const mode = command.id ? 'edit' : 'create';
  const selected = fields.filter(field => command.fieldId ? field.id === command.fieldId : customFieldNeedsGeneration(field, mode, values[field.id]));
  if (!selected.length) return { values: [] };
  const tokens = new Set(selected.flatMap(field => schemeTokens(field.scheme)));
  const context = (await client.query('SELECT * FROM users_scheme_context($1,$2)',
    [['total_counter', 'nabl_counter'].some(token => tokens.has(token)), ['samples_counter', 'sample_category_counter'].some(token => tokens.has(token))])).rows[0];
  if (!context) throw new HttpError(403, 'forbidden', 'You cannot generate User fields.');
  const lookupSelections = await currentLookupSelections('user', client, identity, byId, command.customFields);
  const doc = { ...command.doc, _id: command.id ?? undefined, __scheme_collname: 'Meteor.users', organization_id: identity.organization_id,
    project_field_data: Object.fromEntries(fields.map(field => [field.key, { key: field.key, name: field.label, type: field.fieldType,
      value: values[field.id], display_value: customFieldFormDisplayValue(values[field.id], field,
        [...lookupSelections.get(field.lookupSourceId)?.values() ?? []].filter(Boolean), (raw, definition) => customFieldDateDisplayInZone(raw, definition, command.timeZone)),
      ...(field.scheme ? { scheme: field.scheme } : {}), ...(field.splitter ? { splitter: field.splitter } : {}),
      ...(field.paddedNumber == null ? {} : { padded_number: field.paddedNumber }),
      ...(field.dateFormat ? { date_format: field.dateFormat } : {}), ...(field.datetimeFormat ? { datetime_format: field.datetimeFormat } : {}),
      ...(field.fieldType === 'multi_user_select' ? { is_multi_user_select: true } : {}),
    }])) };
  const now = new Date();
  const clock = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), timestamp: now.getTime() };
  const readPage = async (fieldId, cursor) => (await client.query(`WITH candidates AS MATERIALIZED (
    SELECT subject_user_id,created_at,updated_at,display_text FROM user_field_generation_values
    WHERE organization_id=$1 AND field_key=$2 AND ($3::uuid IS NULL OR subject_user_id<>$3)
      AND ($4::timestamptz IS NULL OR (created_at,updated_at,subject_user_id)<($4::timestamptz,$5::timestamptz,$6::uuid))
    ORDER BY created_at DESC,updated_at DESC,subject_user_id DESC LIMIT 500
  ), budget AS (
    SELECT *,sum(octet_length(display_text)) OVER (ORDER BY created_at DESC,updated_at DESC,subject_user_id DESC) AS bytes,
      row_number() OVER (ORDER BY created_at DESC,updated_at DESC,subject_user_id DESC) AS position FROM candidates
  ) SELECT subject_user_id AS "productId",created_at::text AS "createdAt",updated_at::text AS "updatedAt",display_text AS value
    FROM budget WHERE bytes<=8388608 OR position=1 ORDER BY created_at DESC,updated_at DESC,subject_user_id DESC`,
  [identity.organization_id, byId.get(fieldId).key, command.id, cursor?.createdAt ?? null, cursor?.updatedAt ?? null, cursor?.productId ?? null])).rows;
  const readLookup = async (fieldId, value) => {
    const selections = await currentLookupSelections('user', client, identity, byId, [{ fieldId, value }]);
    return [...selections.get(byId.get(fieldId).lookupSourceId)?.values() ?? []].filter(Boolean);
  };
  return { values: await runMasterGeneration({ kind: 'user', fields, values, doc, settings: context, resolveLookups: true,
    counts: { users: context.userCount, samples: context.sampleCount }, clock, timeZone: command.timeZone, fieldId: command.fieldId, mode }, readPage, { readLookup }) };
}
