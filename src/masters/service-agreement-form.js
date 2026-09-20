import { decimal } from '../templates/input.js';
import { parseCalendarDate } from '../components/ui/date-input.js';

export function serviceAgreementFormDraft(agreement) {
  return { vendorId: agreement?.vendorId ?? '', instrumentIds: agreement?.instrumentIds ?? [], startDate: agreement?.startDate ?? '', endDate: agreement?.endDate ?? '',
    includedServices: agreement?.includedServices ?? [], noOfServices: agreement?.noOfServices ?? '', cost: agreement?.cost ?? '', notes: agreement?.notes ?? '',
    inEffect: agreement?.inEffect ?? false, attachmentFileId: agreement?.attachmentFileId ?? null };
}

export function serviceAgreementFormErrors(draft) {
  const errors = {};
  if (!draft.vendorId) errors.vendorId = 'Vendor is required.';
  if (!draft.instrumentIds.length || draft.instrumentIds.length > 500) errors.instrumentIds = 'Select between 1 and 500 Instruments.';
  const startDate = parseCalendarDate(draft.startDate)?.iso; const endDate = parseCalendarDate(draft.endDate)?.iso;
  if (!startDate) errors.startDate = 'Enter a valid calendar date.';
  if (!endDate) errors.endDate = 'Enter a valid calendar date.';
  if (startDate && endDate && endDate < startDate) errors.endDate = 'End Date cannot be before Start Date.';
  const count = Number(draft.noOfServices === '' ? 0 : draft.noOfServices);
  if (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647) errors.noOfServices = 'Enter a whole number from 0 to 2147483647.';
  try {
    const value = decimal(draft.cost === '' ? '0' : draft.cost, 'Cost');
    if (value.startsWith('-') && /[1-9]/.test(value.split(/[eE]/)[0])) errors.cost = 'Cost cannot be negative.';
  } catch { errors.cost = 'Enter a valid cost.'; }
  if (draft.notes.length > 10000) errors.notes = 'Notes can be at most 10000 characters.';
  return errors;
}

export function serviceAgreementFormBody(draft) {
  return { ...draft, startDate: parseCalendarDate(draft.startDate)?.iso ?? draft.startDate, endDate: parseCalendarDate(draft.endDate)?.iso ?? draft.endDate,
    noOfServices: draft.noOfServices === '' ? 0 : Number(draft.noOfServices), cost: draft.cost === '' ? '0' : draft.cost };
}
