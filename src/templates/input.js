import { HttpError, requireText } from '../auth/errors.js';

export const widgetTypes = Object.freeze({
  template_image_widget: 'image',
  parameter_detail_widget: 'parameter_detail',
  sample_line_item_data_widget: 'text',
  text_widget: 'text', vertical_text_widget: 'text', input_widget: 'text', paragraph_widget: 'text', number_widget: 'numeric',
  formula_widget: 'numeric', result_widget: 'result', checkbox_widget: 'boolean', datepicker_widget: 'date', dropdown_widget: 'option',
  sample_details_widget_v2: 'text', product_detail_widget: 'text', tr_data_widget: 'text', decision_rule_widget: 'text', tr_result_widget: 'text', sno_widget: 'text',
});

export function requirePermission(identity, permission) {
  if (!identity.permission_codes?.includes(permission)) throw new HttpError(403, 'forbidden', 'You do not have permission to perform this action.');
}
export function uuid(value, label = 'Record') {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) throw new HttpError(400, 'invalid_id', `${label} identifier is invalid.`);
  return value;
}
export function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'invalid_revision', 'Reload the record before saving.');
  return value;
}
export function text(value, label, max = 200, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return '';
  if (optional && typeof value === 'string' && value.length <= max) return value;
  return requireText(value, label, max).trim();
}
export function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new HttpError(400, 'invalid_input', `${label} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
export function bool(value, label) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_input', `${label} must be true or false.`);
  return value;
}
export function decimal(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return null;
  if (!['number', 'string'].includes(typeof value)) throw new HttpError(400, 'invalid_number', `${label} must be a finite number.`);
  const lexical = String(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(lexical) || lexical.length > 1000 || !Number.isFinite(Number(lexical))) {
    throw new HttpError(400, 'invalid_number', `${label} must be a finite number.`);
  }
  return lexical;
}
export function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw new HttpError(400, 'invalid_date', 'Enter a valid calendar date.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HttpError(400, 'invalid_date', 'Enter a valid calendar date.');
  return value;
}
export function ownRecord(map, id, label) {
  uuid(id, label);
  if (!Object.hasOwn(map, id)) throw new HttpError(404, 'record_not_found', `${label} was not found in this template.`);
  return map[id];
}
export function fieldsOnly(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'invalid_input', 'The request contains unsupported properties.');
  }
}
