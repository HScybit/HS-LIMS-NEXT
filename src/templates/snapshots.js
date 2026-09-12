import { HttpError } from '../auth/errors.js';
import { loadDefinitions } from './loader.js';
import { uuid } from './input.js';

export async function resolveCaptureVersion(client, identity, templateId, { kind } = {}) {
  const result = await resolveCaptureVersions(client, identity, [templateId], { kind });
  return result.versions.get(templateId.toLowerCase());
}

export async function resolveCaptureVersions(client, identity, templateIds, { kind, additionalVersionIds = [] } = {}) {
  for (const templateId of templateIds) uuid(templateId, 'Template');
  if (!['templates.manage', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'].some((permission) => identity.permission_codes?.includes(permission))) {
    const allowed = (await client.query('SELECT laboratory_auto_job_template() AS id')).rows[0]?.id;
    if (!allowed || templateIds.some((id) => id.toLowerCase() !== allowed) || additionalVersionIds.length) {
      throw new HttpError(403, 'forbidden', 'You do not have permission to prepare this template.');
    }
  }
  const requested = new Set(templateIds.map((templateId) => templateId.toLowerCase()));
  const loaded = await loadDefinitions(client, identity.organization_id, [...new Set(additionalVersionIds)], { templateIds: [...requested], forFreeze: true });
  const versions = new Map(); const models = new Map();
  for (const { model } of [...loaded.definitions.values()].sort((left, right) => left.model.version.templateId.localeCompare(right.model.version.templateId))) {
    if (!requested.has(model.version.templateId)) continue;
    if (!model.version.active) throw new HttpError(422, 'runtime_template_unavailable', 'The selected template is unavailable.');
    if (kind && model.version.kind !== kind) throw new HttpError(422, 'runtime_template_type', 'The selected template has the wrong type.');
    models.set(model.version.templateId, model);
    let versionId = model.version.id;
    if (model.version.status !== 'frozen') {
      try {
        const result = await client.query('SELECT template_snapshot_from_draft($1, $2) AS id', [model.version.id, model.version.revision]);
        versionId = result.rows[0].id;
      } catch (error) {
        if (error.code === '40001') throw new HttpError(409, 'stale_template', 'The template changed. Reload before continuing.');
        throw error;
      }
    }
    versions.set(model.version.templateId, versionId);
  }
  return { versions, models, definitions: loaded.definitions, metrics: loaded.metrics };
}
