import { HttpError } from '../auth/errors.js';

const own = (record, key) => record != null && Object.hasOwn(record, key) ? record[key] : undefined;
const encoder = new TextEncoder();
export const parameterDetailLimits = Object.freeze({ items: 1000, text: 16000, bytes: 16 * 1024 * 1024 });

function primitiveBytes(item) {
  if (item.numberValue !== null && item.numberValue !== undefined) {
    const value = String(item.numberValue);
    const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(value);
    if (match) {
      // PostgreSQL numeric expands scientific notation on read. Admission must
      // cover those stored bytes, not just the short JavaScript exponent text.
      const digits = match[2].length + (match[3]?.length ?? 0);
      const point = match[2].length + Number(match[4]);
      return match[1].length + (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1);
    }
    return encoder.encode(value).byteLength;
  }
  return encoder.encode(item.textValue ?? String(item.booleanValue ?? '')).byteLength;
}

export function parameterDetailKey(title = '') {
  if (typeof title !== 'string') throw new HttpError(400, 'invalid_parameter_detail_key', 'Parameter detail Title must be text.');
  return title.replaceAll('.', '_');
}

// The RPC replaces its first dot, while the widget reads an all-dot-normalized
// Title. A nested title therefore does not read a nested custom field.
export function parameterDetailCustomFieldKey(title) {
  const key = parameterDetailKey(title);
  if (!title.includes('project_field_data.') || title.replace('.', '_') !== key) return null;
  return title.split('.')[1];
}

export function resolveParameterDetail(title, parameter) {
  const key = parameterDetailKey(title);
  if (!key || !parameter) return '';
  const customKey = parameterDetailCustomFieldKey(title);
  if (customKey !== null) return own(own(own(parameter, 'project_field_data'), customKey), 'display_value') || '';
  return own(parameter, key) ?? '';
}

function primitive(value) {
  if (value === null || value === undefined) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean', booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'numeric', numberValue: String(value) };
  if (typeof value === 'string' && value.length <= parameterDetailLimits.text && value.isWellFormed() && !value.includes('\0')) return { kind: 'text', textValue: value };
  throw new HttpError(422, 'unsupported_parameter_detail', 'This parameter detail cannot be displayed as text, a finite number, true/false or a list of these values.');
}

export function parameterDetailItemValue(item) {
  if (item.kind === 'null') return null;
  if (item.kind === 'text' && typeof item.textValue === 'string') return item.textValue;
  if (item.kind === 'boolean' && typeof item.booleanValue === 'boolean') return item.booleanValue;
  if (item.kind === 'numeric' && ['number', 'string'].includes(typeof item.numberValue) && item.numberValue !== '' && Number.isFinite(Number(item.numberValue))) return Number(item.numberValue);
  throw new HttpError(422, 'invalid_parameter_detail_history', 'The saved parameter detail has an unsupported value type.');
}

export function parameterDetailBytes(values) {
  let bytes = 0; let count = 0;
  for (const value of values) {
    if (value.valueType !== 'parameter_detail') continue;
    count += value.parameterDetailKind === 'array' ? value.parameterDetailItemCount : 1;
    const items = value.parameterDetailKind === 'array' ? value.parameterDetailItems ?? [] : [value];
    for (const item of items) bytes += primitiveBytes(item);
    if (count > 500_000 || bytes > parameterDetailLimits.bytes) throw new HttpError(422, 'parameter_detail_limit', 'The captured parameter details exceed the supported data size.');
  }
  return bytes;
}

// Presentation is kept separate from capture: joining array elements into text
// would change their meaning when a formula reads the configured Key.
export function parameterDetailValue(value) {
  const result = { valueType: 'parameter_detail', origin: 'parameter', state: 'present', parameterDetailItemCount: 0 };
  if (value === undefined || value === null || value === '') return { ...result, state: 'empty', parameterDetailKind: 'text' };
  if (!Array.isArray(value)) {
    const { kind, ...payload } = primitive(value);
    return { ...result, ...payload, parameterDetailKind: kind };
  }
  if (value.length > parameterDetailLimits.items) throw new HttpError(422, 'parameter_detail_limit', 'This parameter detail exceeds the supported list size.');
  let bytes = 0;
  const items = Array.from(value, (entry, position) => {
    const item = { position, ...primitive(entry) };
    bytes += primitiveBytes(item);
    if (bytes > parameterDetailLimits.bytes) throw new HttpError(422, 'parameter_detail_limit', 'This parameter detail exceeds the supported data size.');
    return item;
  });
  return { ...result, parameterDetailKind: 'array', parameterDetailItemCount: items.length, parameterDetailItems: items };
}

export function parameterDetailPayload(value) {
  if (!value || value.state !== 'present') return null;
  if (value.parameterDetailKind !== 'array') return parameterDetailItemValue({ ...value, kind: value.parameterDetailKind });
  if (!Array.isArray(value.parameterDetailItems) || value.parameterDetailItems.length !== value.parameterDetailItemCount) {
    throw new HttpError(422, 'invalid_parameter_detail_history', 'The saved parameter detail list is incomplete.');
  }
  return value.parameterDetailItems.map((item, position) => {
    if (item.position !== position) throw new HttpError(422, 'invalid_parameter_detail_history', 'The saved parameter detail list is out of order.');
    return parameterDetailItemValue(item);
  });
}
