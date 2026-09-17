import { vendorFormFields } from './vendor-fields.js';

export function vendorFormDraft(vendor) {
  return Object.fromEntries(vendorFormFields.map(field => [field.key, vendor?.[field.key] ?? field.defaultValue ?? '']));
}

export function vendorFormErrors(draft) {
  const errors = {};
  for (const field of vendorFormFields) {
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
