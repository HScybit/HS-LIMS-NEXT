import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { serviceAgreementCommandInput, serviceAgreementFields, serviceAgreementInput, serviceAgreementRequestFingerprint } from './service-agreement-input.js';

const fields = `item.vendor_id AS "vendorId",item.start_date::text AS "startDate",item.end_date::text AS "endDate",item.no_of_services AS "noOfServices",
  item.cost,item.notes,item.in_effect AS "inEffect",item.attachment_file_id AS "attachmentFileId",item.retired`;

export async function requireServiceAgreementRead(client, identity) {
  if (!identity.permission_codes?.some(code => ['masters.read', 'masters.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view Service Agreements.');
  if (!(await client.query('SELECT service_agreements_can_read() AS allowed')).rows[0]?.allowed) throw new HttpError(403, 'service_agreement_module_access_required', 'Service Agreement module access is required.');
}

export function serviceAgreementError(error) {
  if (error instanceof HttpError) return error;
  if (error.constraint === 'organization_module_access_required') return new HttpError(403, 'service_agreement_module_access_required', 'Service Agreement module access is required.');
  if (error.code === '42501') return new HttpError(403, 'forbidden', 'Your Service Agreement access changed. Reload before continuing.');
  const messages = {
    service_agreement_not_found: [404, 'service_agreement_not_found', 'Service Agreement was not found.'],
    service_agreement_stale_revision: [409, 'stale_service_agreement', 'The Service Agreement changed. Reload before saving.'],
    service_agreement_request_reused: [409, 'save_request_reused', 'This request was already used for another change.'],
    service_agreement_save_request_key: [409, 'save_request_reused', 'This request was already used for another change.'],
    service_agreement_pk: [409, 'service_agreement_exists', 'This Service Agreement identifier is already in use.'],
    service_agreement_reference: [400, 'invalid_agreement_reference', 'Select an available Vendor, Instruments and attachment in this organization.'],
    service_agreement_command_input: [400, 'invalid_service_agreement', 'Check the Service Agreement details and selections.'],
    service_agreement_values: [400, 'invalid_service_agreement', 'Check the Service Agreement dates, count and cost.'],
    module_access_write_isolation: [409, 'service_agreement_write_isolation', 'Retry this Service Agreement change in a new transaction.'],
  };
  if (messages[error.constraint]) return new HttpError(...messages[error.constraint]);
  if (error.code === '23503') return new HttpError(400, 'invalid_agreement_reference', 'Select references from this organization.');
  if (['22003', '22P02', '22007', '22008'].includes(error.code)) return new HttpError(400, 'invalid_service_agreement', 'A Service Agreement number or date exceeds its supported range.');
  return error;
}

async function readAgreement(client, identity, id, atRevision) {
  const historical = atRevision !== undefined;
  const item = (await client.query(`SELECT item.${historical ? 'agreement_id' : 'id'} AS id,item.revision,${fields},
    version.vendor_revision AS "vendorRevision",${historical ? 'version.vendor_name' : 'coalesce(vendor.name,version.vendor_name)'} AS "vendorName",
    version.instrument_count AS "instrumentCount",version.service_count AS "serviceCount",version.instruments_provided AS "instrumentsProvided",version.services_provided AS "servicesProvided",
    version.saved_at AS "savedAt",version.saved_by AS "savedBy",version.previous_revision AS "previousRevision",version.operation
    ${historical ? '' : ',item.created_at AS "createdAt",item.updated_at AS "updatedAt"'}
    FROM ${historical ? 'service_agreement_versions' : 'service_agreements'} item JOIN service_agreement_versions version
      ON version.organization_id=item.organization_id AND version.agreement_id=item.${historical ? 'agreement_id' : 'id'} AND version.revision=item.revision
    ${historical ? '' : 'LEFT JOIN service_agreement_vendor_catalog vendor ON vendor.organization_id=item.organization_id AND vendor.id=item.vendor_id'}
    WHERE item.organization_id=$1 AND item.${historical ? 'agreement_id' : 'id'}=$2 ${historical ? 'AND item.revision=$3' : ''}`,
  historical ? [identity.organization_id, id, atRevision] : [identity.organization_id, id])).rows[0];
  if (!item) return null;
  const args = [identity.organization_id, id, item.revision];
  const instruments = (await client.query(`SELECT selected.instrument_id AS id,selected.position,selected.instrument_revision AS revision,
    ${historical ? 'selected.instrument_name' : 'coalesce(instrument.name,selected.instrument_name)'} AS name,
    ${historical ? 'selected.instrument_code' : 'coalesce(instrument.code,selected.instrument_code)'} AS code
    FROM service_agreement_version_instruments selected ${historical ? '' : 'LEFT JOIN service_agreement_instrument_catalog instrument ON instrument.organization_id=selected.organization_id AND instrument.id=selected.instrument_id'}
    WHERE selected.organization_id=$1 AND selected.agreement_id=$2 AND selected.revision=$3 ORDER BY selected.position LIMIT 501`, args)).rows;
  const services = (await client.query(`SELECT service_code AS code,position FROM service_agreement_version_services
    WHERE organization_id=$1 AND agreement_id=$2 AND revision=$3 ORDER BY position LIMIT 4`, args)).rows;
  const incomplete = () => new HttpError(409, 'incomplete_service_agreement_history', 'Service Agreement history is incomplete. Reload before continuing.');
  if (instruments.length !== item.instrumentCount || instruments.some((row, position) => row.position !== position)
    || services.length !== item.serviceCount || services.some((row, position) => row.position !== position)) throw incomplete();
  const attachment = item.attachmentFileId ? (await client.query(`SELECT id,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256
    FROM service_agreement_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, item.attachmentFileId])).rows[0] : null;
  if (item.attachmentFileId && !attachment) throw incomplete();
  return { ...item, instrumentIds: instruments.map(instrument => instrument.id), instruments: instruments.map(({ position: _position, ...instrument }) => instrument),
    includedServices: services.map(service => service.code), attachment: attachment ? { ...attachment, url: `/api/masters/service-agreements/files/${attachment.id}` } : null };
}

export async function loadServiceAgreement(client, identity, agreementId, { atRevision } = {}) {
  await requireServiceAgreementRead(client, identity); const id = uuid(agreementId, 'Service Agreement').toLowerCase();
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const record = await readAgreement(client, identity, id, atRevision);
  if (!record || atRevision === undefined && record.retired) throw new HttpError(404, 'service_agreement_not_found', 'Service Agreement was not found.');
  return record;
}

async function finishAgreement(client) {
  await client.query('SET CONSTRAINTS service_agreement_relations_complete,service_agreement_head_history IMMEDIATE');
  await client.query('SET CONSTRAINTS service_agreement_relations_complete,service_agreement_head_history DEFERRED');
}

export async function saveServiceAgreement(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); const command = serviceAgreementCommandInput(raw);
  try {
    await client.query('SELECT service_agreements_require_writer()');
    const existing = await readAgreement(client, identity, command.id);
    if (command.revision && !existing) throw new HttpError(404, 'service_agreement_not_found', 'Service Agreement was not found.');
    // A retry must validate a partial date edit against the revision it observed,
    // even when a later save changed the other date or retired the agreement.
    const base = command.revision && existing.revision !== command.revision ? await readAgreement(client, identity, command.id, command.revision) : existing;
    if (command.revision && !base) throw new HttpError(409, 'stale_service_agreement', 'The Service Agreement changed. Reload before saving.');
    const input = serviceAgreementInput(raw, command.revision ? base : null); const fingerprint = serviceAgreementRequestFingerprint(raw, input);
    const prior = (await client.query('SELECT service_agreements_prior_request($1,$2,$3,$4,$5) AS revision',
      [input.id, input.revision, input.requestId, fingerprint, input.revision ? 'update' : 'create'])).rows[0].revision;
    if (prior !== null) return loadServiceAgreement(client, identity, input.id, { atRevision: prior });
    if (existing?.retired) throw new HttpError(404, 'service_agreement_not_found', 'Service Agreement was not found.');
    if ((existing?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_service_agreement', 'The Service Agreement changed. Reload before saving.');
    const args = [input.id, input.revision, input.requestId, fingerprint, ...serviceAgreementFields.map(key => input[key]), input.instrumentIds, input.includedServices];
    const revision = (await client.query(`SELECT service_agreements_save(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args)).rows[0].revision;
    await finishAgreement(client); return loadServiceAgreement(client, identity, input.id, { atRevision: revision });
  } catch (error) { throw serviceAgreementError(error); }
}

export async function retireServiceAgreement(client, identity, raw) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(raw, ['id', 'requestId', 'revision']);
  const input = serviceAgreementCommandInput(raw); integer(input.revision, 'Revision', 1, 2_147_483_646);
  try {
    const revision = (await client.query('SELECT service_agreements_retire($1,$2,$3,$4) AS revision',
      [input.id, input.revision, input.requestId, serviceAgreementRequestFingerprint(raw, input)])).rows[0].revision;
    await finishAgreement(client); return { id: input.id, revision };
  } catch (error) { throw serviceAgreementError(error); }
}
