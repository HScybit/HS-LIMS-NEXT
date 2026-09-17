import { customerFormFields } from './customer-fields.js';

export function customerFormDraft(customer) {
  return Object.fromEntries(customerFormFields.map(field => [field.key, customer?.[field.key] ?? field.defaultValue ?? '']));
}

export function customerFormErrors(draft) {
  const errors = {};
  for (const field of customerFormFields) {
    const value = draft[field.key]; const string = String(value ?? '').trim();
    if (field.required && !string) errors[field.key] = `${field.label} is required.`;
    else if (field.type === 'email' && string && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(string)) errors[field.key] = 'Enter a valid contact email address.';
    else if (field.type === 'number') {
      const number = Number(value);
      if (!string || !Number.isFinite(number)) errors[field.key] = `Enter a number for ${field.label}.`;
      else if (field.step === 1 && !Number.isInteger(number)) errors[field.key] = `${field.label} must be a whole number.`;
      else if (field.min !== undefined && number < field.min || field.max !== undefined && number > field.max) errors[field.key] = `${field.label} must be between ${field.min} and ${field.max}.`;
    }
  }
  return errors;
}

export function customerFormInput(draft) {
  // Decimal text goes unchanged to the native validator and PostgreSQL scale.
  // Invalid blank integers remain null so they cannot silently turn into zero.
  return { ...draft, creditDays: String(draft.creditDays ?? '').trim() === '' ? null : Number(draft.creditDays) };
}
