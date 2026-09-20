import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid } from '../templates/input.js';
import { instrumentServiceLogInput, instrumentBreakdownLogInput, instrumentBreakdownResolutionInput } from './input.js';
import { loggableInstrumentServiceCodes } from '../instruments/service-types.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['instruments.read', 'instrument_services.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view instrument service history.');
  }
}

async function assertInstrument(client, organizationId, instrumentId) {
  const found = await client.query('SELECT 1 FROM instruments WHERE organization_id=$1 AND id=$2', [organizationId, instrumentId]);
  if (!found.rowCount) throw new HttpError(404, 'instrument_not_found', 'Instrument was not found.');
}

function assertActiveServiceCode(serviceCode) {
  if (!loggableInstrumentServiceCodes.includes(serviceCode)) throw new HttpError(422, 'invalid_service_code', 'Select an Instrument service type.');
}

const serviceColumns = `id, instrument_id AS "instrumentId", service_code AS "serviceCode", service_date::text AS "serviceDate", next_service_on::text AS "nextServiceOn",
  summary, details, vendor_id AS "vendorId", vendor_name AS "vendorName", cost, calibration_type AS "calibrationType",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listInstrumentServiceLogs(client, identity, instrumentId) {
  requireRead(identity); const id = uuid(instrumentId, 'Instrument').toLowerCase();
  const result = await client.query(`SELECT ${serviceColumns} FROM instrument_service_logs WHERE organization_id=$1 AND instrument_id=$2 ORDER BY service_date DESC, id`,
    [identity.organization_id, id]);
  return { items: result.rows };
}

export async function createInstrumentServiceLog(client, identity, instrumentId, rawInput) {
  requirePermission(identity, 'instrument_services.manage'); const id = uuid(instrumentId, 'Instrument').toLowerCase();
  const input = instrumentServiceLogInput(rawInput);
  await assertInstrument(client, identity.organization_id, id);
  assertActiveServiceCode(input.serviceCode);
  if (input.vendorId) {
    const vendor = await client.query('SELECT 1 FROM vendors WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.vendorId]);
    if (!vendor.rowCount) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
  }
  const result = await client.query(`INSERT INTO instrument_service_logs(organization_id, instrument_id, service_code, service_date, next_service_on,
      summary, details, vendor_id, vendor_name, cost, calibration_type, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING ${serviceColumns}`,
  [identity.organization_id, id, input.serviceCode, input.serviceDate, input.nextServiceOn, input.summary, input.details,
    input.vendorId, input.vendorName, input.cost, input.calibrationType, identity.user_id]);
  return result.rows[0];
}

export async function updateInstrumentServiceLog(client, identity, instrumentId, logId, rawInput) {
  requirePermission(identity, 'instrument_services.manage');
  const id = uuid(instrumentId, 'Instrument').toLowerCase(); const recordId = uuid(logId, 'Service log').toLowerCase();
  const input = instrumentServiceLogInput(rawInput, { partial: true });
  assertActiveServiceCode(input.serviceCode);
  if (input.vendorId) {
    const vendor = await client.query('SELECT 1 FROM vendors WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.vendorId]);
    if (!vendor.rowCount) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
  }
  const result = await client.query(`UPDATE instrument_service_logs SET service_code=$4, service_date=$5, next_service_on=$6, summary=$7, details=$8,
      vendor_id=$9, vendor_name=$10, cost=$11, calibration_type=$12, revision=revision+1, updated_by=$13, updated_at=now()
    WHERE organization_id=$1 AND instrument_id=$2 AND id=$3 AND revision=$14 RETURNING ${serviceColumns}`,
  [identity.organization_id, id, recordId, input.serviceCode, input.serviceDate, input.nextServiceOn, input.summary, input.details,
    input.vendorId, input.vendorName, input.cost, input.calibrationType, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM instrument_service_logs WHERE organization_id=$1 AND instrument_id=$2 AND id=$3', [identity.organization_id, id, recordId]);
    throw exists.rowCount ? new HttpError(409, 'service_log_changed', 'This service log changed. Reload before saving.')
      : new HttpError(404, 'service_log_not_found', 'Service log was not found.');
  }
  return result.rows[0];
}

const breakdownColumns = `id, instrument_id AS "instrumentId", breakdown_date::text AS "breakdownDate", summary, details, status,
  resolved_on::text AS "resolvedOn", resolution_vendor_id AS "resolutionVendorId", resolution_vendor_name AS "resolutionVendorName",
  resolution_cost AS "resolutionCost", resolution_comments AS "resolutionComments",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listInstrumentBreakdownLogs(client, identity, instrumentId) {
  requireRead(identity); const id = uuid(instrumentId, 'Instrument').toLowerCase();
  const result = await client.query(`SELECT ${breakdownColumns} FROM instrument_breakdown_logs WHERE organization_id=$1 AND instrument_id=$2 ORDER BY breakdown_date DESC, id`,
    [identity.organization_id, id]);
  return { items: result.rows };
}

export async function createInstrumentBreakdownLog(client, identity, instrumentId, rawInput) {
  requirePermission(identity, 'instrument_services.manage'); const id = uuid(instrumentId, 'Instrument').toLowerCase();
  const input = instrumentBreakdownLogInput(rawInput);
  await assertInstrument(client, identity.organization_id, id);
  const result = await client.query(`INSERT INTO instrument_breakdown_logs(organization_id, instrument_id, breakdown_date, summary, details, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING ${breakdownColumns}`,
  [identity.organization_id, id, input.breakdownDate, input.summary, input.details, identity.user_id]);
  return result.rows[0];
}

export async function resolveInstrumentBreakdownLog(client, identity, instrumentId, logId, rawInput) {
  requirePermission(identity, 'instrument_services.manage');
  const id = uuid(instrumentId, 'Instrument').toLowerCase(); const recordId = uuid(logId, 'Breakdown log').toLowerCase();
  const input = instrumentBreakdownResolutionInput(rawInput);
  if (input.vendorId) {
    const vendor = await client.query('SELECT 1 FROM vendors WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.vendorId]);
    if (!vendor.rowCount) throw new HttpError(404, 'vendor_not_found', 'Vendor was not found.');
  }
  const result = await client.query(`UPDATE instrument_breakdown_logs SET status='resolved', resolved_on=$4, resolution_vendor_id=$5, resolution_vendor_name=$6,
      resolution_cost=$7, resolution_comments=$8, revision=revision+1, updated_by=$9, updated_at=now()
    WHERE organization_id=$1 AND instrument_id=$2 AND id=$3 AND revision=$10 AND status='open' RETURNING ${breakdownColumns}`,
  [identity.organization_id, id, recordId, input.resolvedOn, input.vendorId, input.vendorName, input.cost, input.comments, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const existing = await client.query('SELECT status FROM instrument_breakdown_logs WHERE organization_id=$1 AND instrument_id=$2 AND id=$3', [identity.organization_id, id, recordId]);
    if (!existing.rowCount) throw new HttpError(404, 'breakdown_log_not_found', 'Breakdown log was not found.');
    throw existing.rows[0].status === 'resolved' ? new HttpError(409, 'breakdown_already_resolved', 'This breakdown was already resolved.')
      : new HttpError(409, 'breakdown_log_changed', 'This breakdown log changed. Reload before saving.');
  }
  return result.rows[0];
}
