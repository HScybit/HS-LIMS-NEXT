import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';

const templatePurposes = ['sample', 'datasheet', 'report', 'label'];

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view Sample Categories.');
}

// PERN has no visible code for this master; generate one from the name once, like Method of Analysis.
export function generatedSampleCategoryCode(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'SAMPLE-CATEGORY';
}

export function sampleCategoryInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'description', 'abbreviation', 'retentionDays', 'estimatedTimeInDays',
    'enableEvents', 'enableReissue', 'workflowId', 'userIds', 'templates', 'includedFieldIds']);
  const name = text(typeof input.name === 'string' ? input.name.trim() : input.name, 'Name', 200);
  const description = text(typeof input.description === 'string' ? input.description.trim() : input.description, 'Description', 16000, { optional: true });
  const abbreviation = text(typeof input.abbreviation === 'string' ? input.abbreviation.trim() : input.abbreviation, 'Abbreviation', 64);
  if ([name, description, abbreviation].some((value) => value.includes('\0'))) throw new HttpError(400, 'invalid_input', 'Sample Category text cannot contain null characters.');
  const retentionDays = integer(input.retentionDays, 'Retention Days', 0, 2_147_483_647);
  const estimatedTimeInDays = Number(input.estimatedTimeInDays ?? 0);
  if (!Number.isFinite(estimatedTimeInDays) || estimatedTimeInDays < 0) throw new HttpError(400, 'invalid_input', 'Estimated Time in Days must be a non-negative number.');
  const userIds = (input.userIds ?? []).map ? input.userIds ?? [] : [];
  if (!Array.isArray(input.userIds ?? []) || (input.userIds ?? []).length > 500) throw new HttpError(400, 'invalid_sample_category_users', 'Select at most 500 users.');
  const mappedUserIds = (input.userIds ?? []).map((value) => uuid(value, 'User').toLowerCase());
  if (new Set(mappedUserIds).size !== mappedUserIds.length) throw new HttpError(400, 'invalid_sample_category_users', 'Each user can be selected only once.');
  const includedFieldIds = (input.includedFieldIds ?? []).map((value) => uuid(value, 'Custom Field').toLowerCase());
  if (!Array.isArray(input.includedFieldIds ?? []) || includedFieldIds.length > 500) throw new HttpError(400, 'invalid_sample_category_fields', 'Select at most 500 Custom Fields.');
  if (new Set(includedFieldIds).size !== includedFieldIds.length) throw new HttpError(400, 'invalid_sample_category_fields', 'Each Custom Field can be selected only once.');
  const templateInput = input.templates ?? {};
  fieldsOnly(templateInput, templatePurposes);
  const templates = {};
  for (const purpose of templatePurposes) {
    const value = templateInput[purpose];
    templates[purpose] = value == null || value === '' ? null : uuid(value, 'Template').toLowerCase();
  }
  return { id: uuid(input.id, 'Sample Category').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name, description, abbreviation, retentionDays, estimatedTimeInDays,
    enableEvents: bool(input.enableEvents === undefined ? false : input.enableEvents, 'Enable Events'),
    enableReissue: bool(input.enableReissue === undefined ? false : input.enableReissue, 'Enable Reissue'),
    workflowId: input.workflowId == null || input.workflowId === '' ? null : uuid(input.workflowId, 'Workflow').toLowerCase(),
    userIds: mappedUserIds, templates, includedFieldIds };
}

export async function loadSampleCategory(client, identity, categoryId, { atRevision } = {}) {
  requireRead(identity); uuid(categoryId, 'Sample Category');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT ${history ? 'sample_category_id' : 'id'} AS id,revision,code,name,description,abbreviation,
    retention_days AS "retentionDays",estimated_time_in_days AS "estimatedTimeInDays",enable_events AS "enableEvents",enable_reissue AS "enableReissue",active
    ${history ? ',saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'sample_category_versions' : 'sample_categories'} WHERE organization_id=$1 AND ${history ? 'sample_category_id' : 'id'}=$2
    ${history ? 'AND revision=$3' : 'AND active'}`, history ? [identity.organization_id, categoryId, atRevision] : [identity.organization_id, categoryId])).rows[0];
  if (!record) throw new HttpError(404, 'sample_category_not_found', 'Sample Category was not found.');
  // Workflow/template/user/field associations are current-state only, like sample_category_templates already was.
  const workflow = (await client.query(`SELECT link.workflow_id AS id,workflow.name FROM sample_category_workflows link
    LEFT JOIN workflows workflow ON workflow.organization_id=link.organization_id AND workflow.id=link.workflow_id
    WHERE link.organization_id=$1 AND link.sample_category_id=$2 AND link.applies_to='sample' AND link.is_default`, [identity.organization_id, categoryId])).rows[0];
  const templateRows = (await client.query(`SELECT link.purpose,link.template_id AS id,label.name FROM sample_category_templates link
    LEFT JOIN product_template_labels label ON label.organization_id=link.organization_id AND label.template_id=link.template_id
    WHERE link.organization_id=$1 AND link.sample_category_id=$2 AND link.is_default`, [identity.organization_id, categoryId])).rows;
  const templates = Object.fromEntries(templatePurposes.map((purpose) => [purpose, templateRows.find((row) => row.purpose === purpose)?.id ?? null]));
  const templateNames = Object.fromEntries(templatePurposes.map((purpose) => [purpose, templateRows.find((row) => row.purpose === purpose)?.name ?? null]));
  const users = (await client.query(`SELECT user_id AS id, member.username, member.display_name AS name, member.active FROM sample_category_users link
    JOIN sample_category_user_labels member ON member.organization_id=link.organization_id AND member.id=link.user_id
    WHERE link.organization_id=$1 AND link.sample_category_id=$2 ORDER BY lower(member.display_name),link.user_id`, [identity.organization_id, categoryId])).rows;
  const includedFields = (await client.query(`SELECT field_definition_id AS id, field.label, field.active FROM sample_category_included_fields link
    JOIN custom_field_definitions field ON field.organization_id=link.organization_id AND field.id=link.field_definition_id
    WHERE link.organization_id=$1 AND link.sample_category_id=$2 ORDER BY field.display_order,link.field_definition_id`, [identity.organization_id, categoryId])).rows;
  return { ...record, workflowId: workflow?.id ?? null, workflowName: workflow?.name ?? null, templates, templateNames, userIds: users.map((user) => user.id), users,
    includedFieldIds: includedFields.map((field) => field.id), includedFields };
}

const authoredFields = (value) => ({ name: value.name, description: value.description, abbreviation: value.abbreviation, retentionDays: value.retentionDays,
  estimatedTimeInDays: value.estimatedTimeInDays, enableEvents: value.enableEvents, enableReissue: value.enableReissue, workflowId: value.workflowId,
  userIds: value.userIds, templates: value.templates, includedFieldIds: value.includedFieldIds });

async function priorSave(client, identity, id, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sample-category-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT sample_category_id,revision,previous_revision,operation,saved_by FROM sample_category_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.sample_category_id !== id || (prior.previous_revision ?? 0) !== revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadSampleCategory(client, identity, id, { atRevision: prior.revision });
}

export async function saveSampleCategory(client, identity, value) {
  requirePermission(identity, 'masters.manage');
  const input = sampleCategoryInput(value);
  if (input.workflowId) requirePermission(identity, 'workflows.manage');
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  const current = (await client.query('SELECT revision,active,code FROM sample_categories WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'sample_category_not_found', 'Sample Category was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_sample_category', 'The Sample Category changed. Reload before saving.');
  if (!input.workflowId) throw new HttpError(400, 'invalid_sample_category_workflow', 'Select a Workflow for this Sample Category.');
  const workflow = (await client.query(`SELECT 1 FROM workflows workflow WHERE workflow.organization_id=$1 AND workflow.id=$2 AND workflow.active AND workflow.applies_to='sample'
    AND EXISTS (SELECT 1 FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='published')`, [identity.organization_id, input.workflowId])).rowCount;
  if (!workflow) throw new HttpError(400, 'invalid_sample_category_workflow', 'Select an active, published Sample Workflow in this organization.');
  if (input.userIds.length) {
    const users = await client.query('SELECT id FROM sample_category_user_labels WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND active', [identity.organization_id, input.userIds]);
    if (users.rowCount !== input.userIds.length) throw new HttpError(400, 'invalid_sample_category_users', 'Select active users in this organization.');
  }
  if (input.includedFieldIds.length) {
    const fields = await client.query(`SELECT id FROM custom_field_definitions WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND active AND associated_with='sample_product'`,
      [identity.organization_id, input.includedFieldIds]);
    if (fields.rowCount !== input.includedFieldIds.length) throw new HttpError(400, 'invalid_sample_category_fields', 'Select active Sample-Product Custom Fields in this organization.');
  }
  for (const purpose of templatePurposes) {
    const templateId = input.templates[purpose]; if (!templateId) continue;
    const label = (await client.query('SELECT kind,active FROM product_template_labels WHERE organization_id=$1 AND template_id=$2', [identity.organization_id, templateId])).rows[0];
    if (!label?.active || label.kind !== purpose) throw new HttpError(400, 'invalid_sample_category_template', `Select an active ${purpose} Template in this organization.`);
  }
  const code = current?.code ?? generatedSampleCategoryCode(input.name);
  const args = [identity.organization_id, input.id, input.name, input.description, input.abbreviation, input.retentionDays, input.estimatedTimeInDays,
    input.enableEvents, input.enableReissue, input.requestId];
  try {
    if (!input.revision) await client.query(`INSERT INTO sample_categories(organization_id,id,name,description,abbreviation,retention_days,estimated_time_in_days,enable_events,enable_reissue,save_request_id,code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [...args, code]);
    else await client.query(`UPDATE sample_categories SET name=$3,description=$4,abbreviation=$5,retention_days=$6,estimated_time_in_days=$7,enable_events=$8,enable_reissue=$9,
      save_request_id=$10,active=true,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
    await client.query('DELETE FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 AND applies_to=$3', [identity.organization_id, input.id, 'sample']);
    await client.query(`INSERT INTO sample_category_workflows(organization_id,sample_category_id,workflow_id,applies_to,is_default) VALUES($1,$2,$3,'sample',true)`,
      [identity.organization_id, input.id, input.workflowId]);
    await client.query('DELETE FROM sample_category_templates WHERE organization_id=$1 AND sample_category_id=$2', [identity.organization_id, input.id]);
    const selectedPurposes = templatePurposes.filter((purpose) => input.templates[purpose]);
    if (selectedPurposes.length) await client.query(`INSERT INTO sample_category_templates(organization_id,sample_category_id,template_id,purpose,is_default)
      SELECT $1,$2,template_id,purpose,true FROM unnest($3::uuid[],$4::text[]) AS rows(template_id,purpose)`,
      [identity.organization_id, input.id, selectedPurposes.map((purpose) => input.templates[purpose]), selectedPurposes]);
    await client.query('DELETE FROM sample_category_users WHERE organization_id=$1 AND sample_category_id=$2', [identity.organization_id, input.id]);
    if (input.userIds.length) await client.query('INSERT INTO sample_category_users(organization_id,sample_category_id,user_id) SELECT $1,$2,user_id FROM unnest($3::uuid[]) AS rows(user_id)',
      [identity.organization_id, input.id, input.userIds]);
    await client.query('DELETE FROM sample_category_included_fields WHERE organization_id=$1 AND sample_category_id=$2', [identity.organization_id, input.id]);
    if (input.includedFieldIds.length) await client.query(`INSERT INTO sample_category_included_fields(organization_id,sample_category_id,field_definition_id)
      SELECT $1,$2,field_definition_id FROM unnest($3::uuid[]) AS rows(field_definition_id)`, [identity.organization_id, input.id, input.includedFieldIds]);
  } catch (error) {
    if (error.constraint === 'sample_category_save_request_key') throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
    if (error.code === '23505') throw new HttpError(409, 'duplicate_sample_category', 'The Sample Category name or its generated code is already in use.');
    throw error;
  }
  return loadSampleCategory(client, identity, input.id);
}

export async function retireSampleCategory(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'requestId', 'revision']);
  const id = uuid(input.id, 'Sample Category').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM sample_categories WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'sample_category_not_found', 'Sample Category was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_sample_category', 'The Sample Category changed. Reload before deleting.');
  try {
    await client.query(`UPDATE sample_categories SET active=false,save_request_id=$3,revision=revision+1,updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id, requestId]);
  } catch (error) {
    if (error.constraint === 'sample_category_in_use') throw new HttpError(409, 'sample_category_in_use', 'This Sample Category is referenced by one or more records.');
    throw error;
  }
  return { id, revision: revision + 1 };
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

export async function listSampleCategories(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id]; const conditions = ['category.organization_id=$1', 'category.active'];
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  if (search) { const value = bind(literalSearch(search)); conditions.push(`(category.name ILIKE ${value} OR category.description ILIKE ${value})`); }
  const from = `FROM sample_categories category WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const joinedFrom = `FROM sample_categories category
    LEFT JOIN sample_category_workflows mapping ON mapping.organization_id=category.organization_id AND mapping.sample_category_id=category.id
      AND mapping.applies_to='sample' AND mapping.is_default
    LEFT JOIN workflows workflow ON workflow.organization_id=mapping.organization_id AND workflow.id=mapping.workflow_id
    WHERE ${conditions.join(' AND ')}`;
  const rows = (await client.query(`SELECT category.id AS _id,category.revision,category.name,category.description,category.abbreviation,
    category.retention_days AS "retentionDays",category.estimated_time_in_days AS "estimatedTimeInDays",category.created_at AS "createdAt",
    workflow.name AS "workflowName"
    ${joinedFrom} ORDER BY category.created_at DESC,category.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}

export async function sampleCategoryWorkflows(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Workflow search');
  const rows = (await client.query(`SELECT workflow.id,workflow.name FROM workflows workflow WHERE workflow.organization_id=$1 AND workflow.active AND workflow.applies_to='sample'
    AND workflow.name ILIKE $2 AND EXISTS (SELECT 1 FROM workflow_versions WHERE organization_id=$1 AND workflow_id=workflow.id AND status='published')
    ORDER BY workflow.name,workflow.id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function sampleCategoryTemplateOptions(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search', 'purpose']);
  if (!templatePurposes.includes(input.purpose)) throw new HttpError(400, 'invalid_input', 'Select a supported template purpose.');
  const search = searchText(input.search, 'Template search');
  const rows = (await client.query(`SELECT template_id AS id,name FROM product_template_labels WHERE organization_id=$1 AND active AND kind=$2 AND name ILIKE $3
    ORDER BY name,template_id LIMIT 101`, [identity.organization_id, input.purpose, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function sampleCategoryUserOptions(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'User search');
  const rows = (await client.query(`SELECT id,coalesce(display_name,username) AS name FROM sample_category_user_labels WHERE organization_id=$1 AND active
    AND (username ILIKE $2 OR display_name ILIKE $2) ORDER BY display_name,id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function sampleCategoryFieldOptions(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Custom Field search');
  const rows = (await client.query(`SELECT id,label AS name FROM custom_field_definitions WHERE organization_id=$1 AND active AND associated_with='sample_product'
    AND label ILIKE $2 ORDER BY display_order,label,id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
