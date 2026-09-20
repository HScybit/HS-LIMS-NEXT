import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, bool, integer, requirePermission } from '../templates/input.js';
import { organizationDateFormatsInput } from './date-formats.js';
import { sampleWorkflowSettingsInput, sampleWorkflowTypes } from './sample-workflows.js';
import { loadModuleAccess, moduleAccessSettingsInput, saveModuleAccess } from './module-access.js';
import { scalarSettingsFields, scalarSettingsPatch, scalarSettingsDefaults } from './settings-fields.js';
import { reminderSettingsInput, loadReminderSettings, saveReminderSettings } from './reminders.js';
import { accessListSettingsInput, loadAccessListSettings, saveAccessListSettings } from './access-lists.js';
import { templateDefaultsInput, documentSettingsInput, loadDocumentDefaults, saveDocumentDefaults } from './document-defaults.js';
import { loadOrganizationLogoMetadata } from './logo.js';

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

// Every scalar column is aliased to its camelCase key so `stored` (used directly as `settings`
// below) never carries a raw snake_case duplicate alongside it — a duplicate like that once slipped
// through as an "unsupported property" on save, since several tests round-trip the whole `.settings`
// object straight back through PUT.
const scalarColumnList = Object.entries(scalarSettingsFields).map(([key, spec]) => `${spec.column} AS "${key}"`)
  .concat(['operating_start_time AS "operatingStartTime"', 'operating_end_time AS "operatingEndTime"', 'default_sample_category_id AS "defaultSampleCategoryId"']);

export async function loadLaboratorySettings(client, identity, { includeModuleAccess = true } = {}) {
  if (!['settings.read', 'settings.manage'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view organization settings.');
  }
  const stored = (await client.query(`SELECT auto_create_jobs AS "autoCreateJobs",self_allocation_enabled AS "selfAllocationEnabled",allow_receiving_date_edit AS "allowReceivingDateEdit",result_summary_template_id AS "resultSummaryTemplateId",
    job_workflow_id AS "jobWorkflowId",test_request_workflow_id AS "testRequestWorkflowId",revision,updated_by AS "updatedBy",updated_at AS "updatedAt",date_format AS "dateFormat",datetime_format AS "datetimeFormat",
    ${Object.entries(schemeColumns).map(([key, column]) => `${column} AS "${key}"`).join(',')},${sampleWorkflowTypes.map(type => type.column).join(',')},
    ${scalarColumnList.join(',')}
    FROM organization_laboratory_settings WHERE organization_id=$1`, [identity.organization_id])).rows[0];
  const options = (await client.query('SELECT * FROM laboratory_settings_options() ORDER BY kind,label,id')).rows;
  const [categoryOptions, roleOptions, reminders, accessLists, documentDefaults, logo] = await Promise.all([
    client.query('SELECT id, name AS label FROM sample_categories WHERE organization_id=$1 AND active ORDER BY lower(name)', [identity.organization_id]),
    client.query('SELECT id, name AS label FROM roles WHERE organization_id=$1 AND active ORDER BY lower(name)', [identity.organization_id]),
    loadReminderSettings(client, identity), loadAccessListSettings(client, identity), loadDocumentDefaults(client, identity),
    loadOrganizationLogoMetadata(client, identity),
  ]);
  const settings = stored ?? { autoCreateJobs: false, selfAllocationEnabled: false, allowReceivingDateEdit: false, resultSummaryTemplateId: null, jobWorkflowId: null, testRequestWorkflowId: null, dateFormat: null, datetimeFormat: null, revision: 0,
    ...Object.fromEntries(Object.keys(schemeColumns).map((key) => [key, null])), defaultSampleCategoryId: null, ...scalarSettingsDefaults };
  // Postgres returns time columns as "HH:MM:SS"; the <input type="time"> UI (and round-trip tests) expect "HH:MM".
  if (stored) { settings.operatingStartTime = stored.operatingStartTime?.slice(0, 5) ?? null; settings.operatingEndTime = stored.operatingEndTime?.slice(0, 5) ?? null; }
  settings.sampleWorkflows = {};
  for (const { key, column } of sampleWorkflowTypes) { settings.sampleWorkflows[key] = settings[column] ?? null; delete settings[column]; }
  if (includeModuleAccess) {
    const moduleAccess = await loadModuleAccess(client, identity, { currentRevision: settings.revision });
    settings.moduleAccess = moduleAccess.modules;
    settings.moduleAccessRevision = moduleAccess.revision;
  }
  Object.assign(settings, reminders, accessLists, documentDefaults);
  return { settings,
    templates: options.filter((row) => row.kind === 'template'),
    workflows: options.filter(row => ['workflow', 'workflow_retained'].includes(row.kind)).map(row => ({ ...row, available: row.kind === 'workflow' })),
    sampleWorkflowOptions: options.filter(row => ['sample_workflow', 'sample_workflow_retained'].includes(row.kind))
      .map(row => ({ id: row.id, label: row.label, available: row.kind === 'sample_workflow' })),
    // Not a submittable field: kept alongside settings (like templates/roleOptions) rather than
    // inside it, since several tests round-trip the entire `.settings` object straight back
    // through PUT and logo isn't part of that JSON save.
    logo, sampleCategoryOptions: categoryOptions.rows, roleOptions: roleOptions.rows,
    canManage: identity.permission_codes.includes('settings.manage') };
}

export async function saveLaboratorySettings(client, identity, input) {
  requirePermission(identity, 'settings.manage');
  fieldsOnly(input, ['revision', 'autoCreateJobs', 'selfAllocationEnabled', 'allowReceivingDateEdit', 'resultSummaryTemplateId', 'jobWorkflowId', 'testRequestWorkflowId', ...Object.keys(schemeColumns), 'dateFormat', 'datetimeFormat', 'sampleWorkflows', 'moduleAccess',
    ...Object.keys(scalarSettingsFields), 'operatingStartTime', 'operatingEndTime', 'defaultSampleCategoryId',
    'reminderTimes', 'reminderEmails', 'allocatedFields', 'sampleListingFields', 'projectTabs', 'customTableRoleIds', 'templateDefaults', 'documentSettings']);
  const schemeSettings = laboratorySchemeSettingsInput(input);
  const dateFormats = organizationDateFormatsInput(input);
  const sampleWorkflows = sampleWorkflowSettingsInput(input);
  const moduleAccess = moduleAccessSettingsInput(input);
  const scalarPatch = scalarSettingsPatch(input);
  const reminders = reminderSettingsInput(input);
  const accessLists = accessListSettingsInput(input);
  const templateDefaults = templateDefaultsInput(input);
  const documentSettings = documentSettingsInput(input);
  const defaultCategoryProvided = Object.hasOwn(input, 'defaultSampleCategoryId');
  const defaultCategoryId = defaultCategoryProvided
    ? (input.defaultSampleCategoryId === null ? null : uuid(input.defaultSampleCategoryId, 'Default Sample Category').toLowerCase())
    : undefined;
  integer(input.revision, 'Revision', 0, 2_147_483_646); bool(input.autoCreateJobs, 'Auto Create Jobs');
  if (input.selfAllocationEnabled !== undefined) bool(input.selfAllocationEnabled, 'Enable Self Allocation');
  if (input.allowReceivingDateEdit !== undefined) bool(input.allowReceivingDateEdit, 'Allow Editing Receiving Date');
  if (input.resultSummaryTemplateId != null) uuid(input.resultSummaryTemplateId, 'Summary template');
  if (input.jobWorkflowId != null) uuid(input.jobWorkflowId, 'Job workflow');
  const requestWorkflowProvided = Object.hasOwn(input, 'testRequestWorkflowId');
  if (requestWorkflowProvided && input.testRequestWorkflowId !== null) uuid(input.testRequestWorkflowId, 'Test request workflow');
  if (moduleAccess !== null) {
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
  if (defaultCategoryId && defaultCategoryId !== current.settings.defaultSampleCategoryId
    && !current.sampleCategoryOptions.some((row) => row.id === defaultCategoryId)) {
    throw new HttpError(422, 'invalid_default_sample_category', 'Select an active sample category.');
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
  await saveModuleAccess(client, saved.rows[0].revision, moduleAccess);
  // Step-7 fields: a second, dynamically-built UPDATE (columns present in this request only) rather
  // than folding ~50 more fields into the hand-tuned positional statement above. organization_laboratory_settings
  // has a guard trigger requiring every UPDATE to advance revision by exactly one and stamp updated_by/updated_at
  // for the current actor/transaction, so this statement does that too — a save that touches both an existing
  // tab and a step-7 tab advances revision by two, which is harmless (every lookup elsewhere compares with
  // "<=", never "="), rather than folding both statements into one and risking the proven existing SQL above.
  const patchColumns = [...scalarPatch.columns]; const patchValues = [...scalarPatch.values];
  if (defaultCategoryProvided) { patchColumns.push('default_sample_category_id'); patchValues.push(defaultCategoryId); }
  let finalRevision = saved.rows[0].revision;
  if (patchColumns.length) {
    const setClause = patchColumns.map((column, index) => `${column}=$${index + 4}`).join(',');
    const patched = await client.query(
      `UPDATE organization_laboratory_settings SET ${setClause},revision=revision+1,updated_by=$2,updated_at=now()
       WHERE organization_id=$1 AND revision=$3 RETURNING revision`,
      [identity.organization_id, identity.user_id, finalRevision, ...patchValues]);
    if (!patched.rowCount) throw new HttpError(409, 'stale_settings', 'Organization settings changed. Reload before saving.');
    finalRevision = patched.rows[0].revision;
  }
  if (reminders !== null) await saveReminderSettings(client, identity, reminders);
  await saveAccessListSettings(client, identity, accessLists);
  await saveDocumentDefaults(client, identity, { templateDefaults, documentSettings });
  return { revision: finalRevision };
}
