import { HttpError } from '../auth/errors.js';
import { loadDefinition } from './loader.js';
import { uuid } from './input.js';

export async function resolveCaptureVersion(client, identity, templateId, { kind } = {}) {
  uuid(templateId, 'Template');
  if (!['templates.manage', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to prepare this template.');
  }
  const { model } = await loadDefinition(client, identity.organization_id, null, { templateId, forFreeze: true });
  if (!model.version.active) throw new HttpError(422, 'runtime_template_unavailable', 'The selected template is unavailable.');
  if (kind && model.version.kind !== kind) throw new HttpError(422, 'runtime_template_type', 'The selected template has the wrong type.');
  if (model.version.status === 'frozen') return model.version.id;
  try {
    const result = await client.query('SELECT template_snapshot_from_draft($1, $2) AS id', [model.version.id, model.version.revision]);
    return result.rows[0].id;
  } catch (error) {
    if (error.code === '40001') throw new HttpError(409, 'stale_template', 'The template changed. Reload before continuing.');
    throw error;
  }
}
