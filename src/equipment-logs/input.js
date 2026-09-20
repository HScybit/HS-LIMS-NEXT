import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, text, decimal, dateOnly } from '../templates/input.js';

function optionalDecimal(value, label) {
  if (value == null || value === '') return null;
  const parsed = decimal(value, label);
  if (Number(parsed) < 0) throw new HttpError(400, 'invalid_input', `${label} cannot be negative.`);
  return parsed;
}

export function instrumentServiceLogInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'serviceCode', 'serviceDate', 'nextServiceOn', 'summary', 'details', 'vendorId', 'vendorName', 'cost', 'calibrationType']);
  const serviceCode = text(input.serviceCode, 'Service type', 64);
  const serviceDate = dateOnly(input.serviceDate);
  const nextServiceOn = input.nextServiceOn == null || input.nextServiceOn === '' ? null : dateOnly(input.nextServiceOn);
  if (nextServiceOn !== null && nextServiceOn < serviceDate) throw new HttpError(400, 'invalid_next_service_date', 'Next service date cannot be before the service date.');
  const summary = text(input.summary, 'Summary', 500);
  const details = input.details == null || input.details === '' ? null : text(input.details, 'Details', 10000);
  const vendorId = input.vendorId == null ? null : uuid(input.vendorId, 'Vendor').toLowerCase();
  const vendorName = input.vendorName == null || input.vendorName === '' ? null : text(input.vendorName, 'Vendor name', 250);
  const cost = optionalDecimal(input.cost, 'Cost');
  const calibrationType = input.calibrationType == null || input.calibrationType === '' ? null : text(input.calibrationType, 'Calibration type', 100);
  return { serviceCode, serviceDate, nextServiceOn, summary, details, vendorId, vendorName, cost, calibrationType,
    ...(partial ? { revision: integer(input.revision, 'Service log revision', 1, 2_147_483_647) } : {}) };
}

export function instrumentBreakdownLogInput(input) {
  fieldsOnly(input, ['breakdownDate', 'summary', 'details']);
  return { breakdownDate: dateOnly(input.breakdownDate), summary: text(input.summary, 'Summary', 500),
    details: input.details == null || input.details === '' ? null : text(input.details, 'Details', 10000) };
}

export function instrumentBreakdownResolutionInput(input) {
  fieldsOnly(input, ['revision', 'resolvedOn', 'vendorId', 'vendorName', 'cost', 'comments']);
  const vendorId = input.vendorId == null ? null : uuid(input.vendorId, 'Vendor').toLowerCase();
  const vendorName = input.vendorName == null || input.vendorName === '' ? null : text(input.vendorName, 'Vendor name', 250);
  if (!vendorId && !vendorName) throw new HttpError(400, 'invalid_resolution', 'Select a vendor or enter a vendor name.');
  const cost = decimal(input.cost, 'Cost');
  if (Number(cost) < 0) throw new HttpError(400, 'invalid_input', 'Cost cannot be negative.');
  return { revision: integer(input.revision, 'Breakdown log revision', 1, 2_147_483_647), resolvedOn: dateOnly(input.resolvedOn),
    vendorId, vendorName, cost, comments: text(input.comments, 'Resolution comments', 10000) };
}
