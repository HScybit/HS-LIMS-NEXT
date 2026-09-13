import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, bool, integer, requirePermission } from '../templates/input.js';

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

export async function loadLaboratorySettings(client, identity) {
  if (!['settings.read', 'settings.manage'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view organization settings.');
  }
  const stored = (await client.query(`SELECT auto_create_jobs AS "autoCreateJobs",self_allocation_enabled AS "selfAllocationEnabled",result_summary_template_id AS "resultSummaryTemplateId",
    job_workflow_id AS "jobWorkflowId",revision,updated_by AS "updatedBy",updated_at AS "updatedAt",
    ${Object.entries(schemeColumns).map(([key, column]) => `${column} AS "${key}"`).join(',')}
    FROM organization_laboratory_settings WHERE organization_id=$1`, [identity.organization_id])).rows[0];
  const options = (await client.query('SELECT * FROM laboratory_settings_options() ORDER BY kind,label,id')).rows;
  return { settings: stored ?? { autoCreateJobs: false, selfAllocationEnabled: false, resultSummaryTemplateId: null, jobWorkflowId: null, revision: 0,
    ...Object.fromEntries(Object.keys(schemeColumns).map((key) => [key, null])) },
    templates: options.filter((row) => row.kind === 'template'), workflows: options.filter((row) => row.kind === 'workflow'),
    canManage: identity.permission_codes.includes('settings.manage') };
}

export async function saveLaboratorySettings(client, identity, input) {
  requirePermission(identity, 'settings.manage');
  fieldsOnly(input, ['revision', 'autoCreateJobs', 'selfAllocationEnabled', 'resultSummaryTemplateId', 'jobWorkflowId', ...Object.keys(schemeColumns)]);
  const schemeSettings = laboratorySchemeSettingsInput(input);
  integer(input.revision, 'Revision', 0, 2_147_483_646); bool(input.autoCreateJobs, 'Auto Create Jobs');
  if (input.selfAllocationEnabled !== undefined) bool(input.selfAllocationEnabled, 'Enable Self Allocation');
  if (input.resultSummaryTemplateId != null) uuid(input.resultSummaryTemplateId, 'Summary template');
  if (input.jobWorkflowId != null) uuid(input.jobWorkflowId, 'Job workflow');
  const current = await loadLaboratorySettings(client, identity);
  if (current.settings.revision !== input.revision) throw new HttpError(409, 'stale_settings', 'Organization settings changed. Reload before saving.');
  if (input.resultSummaryTemplateId && !current.templates.some((row) => row.id === input.resultSummaryTemplateId.toLowerCase())) {
    throw new HttpError(422, 'invalid_job_template', 'Select an active datasheet summary template.');
  }
  if (input.jobWorkflowId && !current.workflows.some((row) => row.id === input.jobWorkflowId.toLowerCase())) {
    throw new HttpError(422, 'invalid_job_workflow', 'Select a published test request workflow.');
  }
  const saved = await client.query(`INSERT INTO organization_laboratory_settings(organization_id,auto_create_jobs,result_summary_template_id,job_workflow_id,updated_by,${Object.values(schemeColumns).join(',')},self_allocation_enabled)
    VALUES($1,$2,$3,$4,$5,$7,$8,$9,$10,$11,coalesce($13,false)) ON CONFLICT(organization_id) DO UPDATE SET auto_create_jobs=EXCLUDED.auto_create_jobs,
      result_summary_template_id=EXCLUDED.result_summary_template_id,job_workflow_id=EXCLUDED.job_workflow_id,
      self_allocation_enabled=coalesce($13,organization_laboratory_settings.self_allocation_enabled),
      ${Object.values(schemeColumns).map((column) => `${column}=CASE WHEN $12 THEN EXCLUDED.${column} ELSE organization_laboratory_settings.${column} END`).join(',')},
      revision=organization_laboratory_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
    WHERE organization_laboratory_settings.revision=$6 RETURNING revision`,
  [identity.organization_id, input.autoCreateJobs, input.resultSummaryTemplateId ?? null, input.jobWorkflowId ?? null, identity.user_id, input.revision,
    ...Object.keys(schemeColumns).map((key) => schemeSettings?.[key] ?? null), schemeSettings !== null, input.selfAllocationEnabled ?? null]);
  if (!saved.rowCount) throw new HttpError(409, 'stale_settings', 'Organization settings changed. Reload before saving.');
  return { revision: saved.rows[0].revision };
}
