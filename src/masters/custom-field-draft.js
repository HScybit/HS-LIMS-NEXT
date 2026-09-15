import { customFieldInitialValue } from '../custom-fields/form-values.js';

export function masterCustomFieldDraft(fields, storedFields = [], previousFields = [], current = {}) {
  const storedById = new Map(storedFields.map(field => [field.fieldId, field]));
  const storedByKey = new Map(storedFields.map(field => [field.key, field]));
  const previousByKey = new Map(previousFields.map(field => [field.key, field]));
  return Object.fromEntries(fields.map(field => {
    if (field.fieldType !== 'lookup') return [field.id, Object.hasOwn(current, field.id) ? current[field.id] : customFieldInitialValue(field, storedById.get(field.id))];
    const previous = previousByKey.get(field.key);
    return [field.id, previous && Object.hasOwn(current, previous.id) && current[previous.id] !== undefined
      ? current[previous.id] : customFieldInitialValue(field, storedByKey.get(field.key))];
  }));
}
