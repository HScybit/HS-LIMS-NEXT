import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';

export function complaintRetestInput(input) {
  if (!Array.isArray(input) || !input.length || input.length > 5000) {
    throw new HttpError(400, 'invalid_complaint_retest', 'Select between 1 and 5,000 existing complaint tests for retest.');
  }
  const ids = input.map(value => uuid(value, 'Complaint retest').toLowerCase());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_complaint_retest', 'Select each complaint test only once.');
  return ids;
}
