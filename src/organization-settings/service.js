import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, bool, integer, requirePermission } from '../templates/input.js';
import { organizationDateFormatsInput } from './date-formats.js';
import { sampleWorkflowSettingsInput, sampleWorkflowTypes } from './sample-workflows.js';
import { instrumentServiceSettingsInput } from './instrument-services.js';
import { loadModuleAccess, moduleAccessSettingsInput, saveModuleAccess } from './module-access.js';

const schemeColumns = { schemeCurrentYearDigits: 'scheme_current_year_digits', schemeNextYearDigits: 'scheme_next_year_digits',
  schemeSeparator: 'scheme_separator', schemeMonthFormat: 'scheme_month_format', schemeNonNablStartNumber: 'scheme_non_nabl_start_number' };

export function laboratorySchemeSettingsInput(input) {
  const keys = Object.keys(schemeColumns); const present = keys.filter((key) => Object.hasOwn(input, key));
  if (!present.length) return null;
  if (present.length !== keys.length) throw new HttpError(400, 'invalid_scheme_settings', 'Provide all number scheme settings together.');
  return Object.fromEntries(keys.map((key) => {
    const value = input[key]; const maximum = key === 'schemeSeparator' ? 250 : 128;
    if (value !== null && (typeof value !== 'string' || value.length > maximum || !value.isWellFormed() || value.includes('\0'))) {
      throw new HttpError(400, 'invalid_scheme_settings', `Number scheme settings must be text of at most ${maximum} characters.`);
    }
    if (key === 'schemeMonthFormat' && value !== null && !['', 'number', 'short', 'long'].includes(value)) {
      throw new HttpError(400, 'invalid_scheme_settings', 'Select a valid month format.');
    }
    return [key, value];
  }));
}

export async function loadLaboratorySettings(client, identity, { includeModuleAccess = true } = {}) {
  if (!['settings.read', 'settings.manage'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view organization settings.');
  }
  const stored = (await client.query(`SELECT auto_create_jobs AS "autoCreateJobs",self_allocation_enabled AS "selfAllocationEnabled",allow_receiving_date_edit AS "allowReceivingDateEdit",result_summary_template_id AS "resultSummaryTemplateId",
    job_workflow_id AS "jobWorkflowId",test_request_workflow_id AS "testRequestWorkflowId",revision,updated_by AS "updatedBy",updated_at AS "updatedAt",date_format AS "dateFormat",datetime_format AS "datetimeFormat",
    ${Object.entries(schemeColumns).map(([key, column]) => `${column} AS "${key}"`).join(',')},${sampleWorkflowTypes.map(type => type.column).join(',')},
    coalesce((SELECT json_agg(json_build_object('id',entry.id,'serviceCode',entry.service_code,'displayLabel',entry.display_label,'isActive',entry.active) ORDER BY entry.position)
      FROM organization_instrument_service_entries entry
      WHERE entry.organization_id=organization_laboratory_settings.organization_id AND entry.revision=(
        SELECT version.revision FROM organization_instrument_service_versions version
        WHERE version.organization_id=organization_laboratory_settings.organization_id AND version.revision<=organization_laboratory_settings.revision
        ORDER BY version.revision DESC LIMIT 1)), '[]'::json) AS "instrumentServiceTypes"
    FROM organization_laboratory_settings WHERE organization_id=$1`, [identity.organization_id])).rows[0];
  const options = (await client.query('SELECT * FROM laboratory_settings_options() ORDER BY kind,label,id')).rows;
  const settings = stored ?? { autoCreateJobs: false, selfAllocationEnabled: false, allowReceivingDateEdit: false, resultSummaryTemplateId: null, jobWorkflowId: null, testRequestWorkflowId: null, dateFormat: null, datetimeFormat: null, revision: 0,
    instrumentServiceTypes: [], ...Object.fromEntries(Object.keys(schemeColumns).map((key) => [key, null])) };
  settings.sampleWorkflows = {};
  for (const { key, column } of sampleWorkflowTypes) { settings.sampleWorkflows[key] = settings[column] ?? null; delete settings[column]; }
  if (includeModuleAccess) {
    const moduleAccess = await loadModuleAccess(client, identity, { currentRevision: settings.revision });
    settings.moduleAccess = moduleAccess.modules;
    settings.moduleAccessRevision = moduleAccess.revision;
  }
  return { settings,
    templates: options.filter((row) => row.kind === 'template'),
    workflows: options.filter(row => ['workflow', 'workflow_retained'].includes(row.kind)).map(row => ({ ...row, available: row.kind === 'workflow' })),
    sampleWorkflowOptions: options.filter(row => ['sample_workflow', 'sample_workflow_retained'].includes(row.kind))
      .map(row => ({ id: row.id, label: row.label, available: row.kind === 'sample_workflow' })),
    canManage: identity.permission_codes.includes('settings.manage') };
}

export async function saveLaboratorySettings(client, identity, input) {
  requirePermission(identity, 'settings.manage');
  fieldsOnly(input, ['revision', 'autoCreateJobs', 'selfAllocationEnabled', 'allowReceivingDateEdit', 'resultSummaryTemplateId', 'jobWorkflowId', 'testRequestWorkflowId', ...Object.keys(schemeColumns), 'dateFormat', 'datetimeFormat', 'sampleWorkflows', 'instrumentServiceTypes', 'moduleAccess']);
  const instrumentServices = instrumentServiceSettingsInput(input);
  const schemeSettings = laboratorySchemeSettingsInput(input);
  const dateFormats = organizationDateFormatsInput(input);
  const sampleWorkflows = sampleWorkflowSettingsInput(input);
  const moduleAccess = moduleAccessSettingsInput(input);
  integer(input.revision, 'Revision', 0, 2_147_483_646); bool(input.autoCreateJobs, 'Auto Create Jobs');
  if (input.selfAllocationEnabled !== undefined) bool(input.selfAllocationEnabled, 'Enable Self Allocation');
  if (input.allowReceivingDateEdit !== undefined) bool(input.allowReceivingDateEdit, 'Allow Editing Receiving Date');
  if (input.resultSummaryTemplateId != null) uuid(input.resultSummaryTemplateId, 'Summary template');
  if (input.jobWorkflowId != null) uuid(input.jobWorkflowId, 'Job workflow');
  const requestWorkflowProvided = Object.hasOwn(input, 'testRequestWorkflowId');
  if (requestWorkflowProvided && input.testRequestWorkflowId !== null) uuid(input.testRequestWorkflowId, 'Test request workflow');
  if (instrumentServices !== null || moduleAccess !== null) {
    try { await client.query('SELECT organization_lock_settings_writer()'); }
    catch (error) {
      if (error.code === '42501') throw new HttpError(403, 'forbidden', 'Your organization settings access changed. Reload before saving.');
      throw error;
    }
  }
  const current = await loadLaboratorySettings(client, identity, { includeModuleAccess: false });
  if (current.settings.revision !== input.revision) throw new HttpError(409, 'stale_settings', 'Organization settings changed. Reload before saving.');
  const requestWorkflowId = requestWorkflowProvided ? input.testRequestWorkflowId?.toLowerCase() ?? null : current.settings.testRequestWorkflowId;
  const jobWorkflowId = input.jobWorkflowId?.toLowerCase() ?? null;
  const retainedCommonWorkflow = requestWorkflowId === jobWorkflowId
    && [current.settings.testRequestWorkflowId, current.settings.jobWorkflowId].includes(requestWorkflowId);
  if (input.resultSummaryTemplateId && input.resultSummaryTemplateId.toLowerCase() !== current.settings.resultSummaryTemplateId
    && !current.templates.some((row) => row.id === input.resultSummaryTemplateId.toLowerCase())) {
    throw new HttpError(422, 'invalid_job_template', 'Select an active datasheet summary template.');
  }
  if (jobWorkflowId && jobWorkflowId !== current.settings.jobWorkflowId && !retainedCommonWorkflow
    && !current.workflows.some(row => row.id === jobWorkflowId && row.available)) {
    throw new HttpError(422, 'invalid_job_workflow', 'Select a published test request workflow.');
  }
  if (requestWorkflowId && requestWorkflowId !== current.settings.testRequestWorkflowId && !retainedCommonWorkflow
    && !current.workflows.some(row => row.id === requestWorkflowId && row.available)) {
    throw new HttpError(422, 'invalid_test_request_workflow', 'Select an active published test request workflow in this organization.');
  }
  if (sampleWorkflows && sampleWorkflowTypes.some(({ key }) => sampleWorkflows[key] && sampleWorkflows[key] !== current.settings.sampleWorkflows[key]
    && !current.sampleWorkflowOptions.some(row => row.id === sampleWorkflows[key] && row.available))) {
    throw new HttpError(422, 'invalid_sample_workflow', 'Select an active published sample workflow in this organization.');
  }
  let saved;
  try {
    if (input.revision === 0) {
      saved = await client.query(`INSERT INTO organization_laboratory_settings(organization_id,auto_create_jobs,result_summary_template_id,job_workflow_id,updated_by,${Object.values(schemeColumns).join(',')},self_allocation_enabled,date_format,datetime_format,allow_receiving_date_edit,${sampleWorkflowTypes.map(type => type.column).join(',')},test_request_workflow_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,${sampleWorkflowTypes.map((_, index) => `$${index + 15}`).join(',')},$21)
        ON CONFLICT(organization_id) DO NOTHING RETURNING revision`,
      [identity.organization_id, input.autoCreateJobs, input.resultSummaryTemplateId ?? null, input.jobWorkflowId ?? null, identity.user_id,
        ...Object.keys(schemeColumns).map(key => schemeSettings?.[key] ?? null), input.selfAllocationEnabled ?? false,
        dateFormats.dateFormat ?? null, dateFormats.datetimeFormat ?? null, input.allowReceivingDateEdit ?? false,
        ...sampleWorkflowTypes.map(({ key }) => sampleWorkflows?.[key] ?? null), requestWorkflowId]);
    } else {
      // UPDATE avoids INSERT reference checks for retained unavailable selections.
      saved = await client.query(`UPDATE organization_laboratory_settings SET auto_create_jobs=$2,
      result_summary_template_id=$3,job_workflow_id=$4,
      self_allocation_enabled=coalesce($13,organization_laboratory_settings.self_allocation_enabled),
      allow_receiving_date_edit=coalesce($18,organization_laboratory_settings.allow_receiving_date_edit),
      date_format=CASE WHEN $16 THEN $14 ELSE organization_laboratory_settings.date_format END,
      datetime_format=CASE WHEN $17 THEN $15 ELSE organization_laboratory_settings.datetime_format END,
      ${Object.values(schemeColumns).map((column, index) => `${column}=CASE WHEN $12 THEN $${index + 7} ELSE organization_laboratory_settings.${column} END`).join(',')},
      ${sampleWorkflowTypes.map(({ column }, index) => `${column}=CASE WHEN $19 THEN $${index + 20}::uuid ELSE organization_laboratory_settings.${column} END`).join(',')},
      test_request_workflow_id=CASE WHEN $26 THEN $27::uuid ELSE organization_laboratory_settings.test_request_workflow_id END,
      revision=organization_laboratory_settings.revision+1,updated_by=$5,updated_at=now()
    WHERE organization_id=$1 AND organization_laboratory_settings.revision=$6 RETURNING revision`,
  [identity.organization_id, input.autoCreateJobs, input.resultSummaryTemplateId ?? null, input.jobWorkflowId ?? null, identity.user_id, input.revision,
    ...Object.keys(schemeColumns).map((key) => schemeSettings?.[key] ?? null), schemeSettings !== null, input.selfAllocationEnabled ?? null,
    dateFormats.dateFormat ?? null, dateFormats.datetimeFormat ?? null, Object.hasOwn(dateFormats, 'dateFormat'), Object.hasOwn(dateFormats, 'datetimeFormat'), input.allowReceivingDateEdit ?? null,
    sampleWorkflows !== null, ...sampleWorkflowTypes.map(({ key }) => sampleWorkflows?.[key] ?? null), requestWorkflowProvided, requestWorkflowId]);
    }
  } catch (error) {
    if (error.code === '23514' && error.constraint === 'sample_workflow_active_reference') {
      throw new HttpError(422, 'invalid_sample_workflow', 'Select an active published sample workflow in this organization.');
    }
    if (error.code === '23514' && error.constraint === 'test_request_workflow_active_reference') {
      throw new HttpError(422, 'invalid_test_request_workflow', 'Select an active published test request workflow in this organization.');
    }
    throw error;
  }
  if (!saved.rowCount) throw new HttpError(409, 'stale_settings', 'Organization settings changed. Reload before saving.');
  if (instrumentServices !== null) await client.query('SELECT organization_save_instrument_services($1,$2::uuid[],$3::text[],$4::text[],$5::boolean[])',
    [saved.rows[0].revision, instrumentServices.map(row => row.id), instrumentServices.map(row => row.serviceCode),
      instrumentServices.map(row => row.displayLabel), instrumentServices.map(row => row.isActive)]);
  await saveModuleAccess(client, saved.rows[0].revision, moduleAccess);
  return { revision: saved.rows[0].revision };
}
