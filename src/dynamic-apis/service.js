import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid } from '../templates/input.js';
import { transaction } from '../db/pool.js';
import { dynamicApiInput, dynamicApiTestRunInput, dynamicApiTokenInput, dynamicApiIdInput } from './input.js';
import { runDynamicApiCode } from './sandbox.js';
import { executeWhitelistedQuery } from './resources.js';

const TIMEOUT_MS = 10_000;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['dynamic_apis.read', 'dynamic_apis.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view dynamic APIs.');
  }
}

const columns = `id, name, url_key AS "urlKey", http_method AS "httpMethod", draft_code AS "draftCode", live_code AS "liveCode", enabled,
  revision, published_by AS "publishedBy", published_at AS "publishedAt", created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listDynamicApis(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${columns} FROM dynamic_apis WHERE organization_id=$1 ORDER BY name`, [identity.organization_id]);
  return { items: result.rows };
}

export async function getDynamicApi(client, identity, apiId) {
  requireRead(identity); const id = dynamicApiIdInput(apiId);
  const result = await client.query(`SELECT ${columns} FROM dynamic_apis WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
  return result.rows[0];
}

export async function createDynamicApi(client, identity, rawInput) {
  requirePermission(identity, 'dynamic_apis.manage');
  const input = dynamicApiInput(rawInput);
  try {
    const result = await client.query(`INSERT INTO dynamic_apis(organization_id, name, url_key, http_method, draft_code, enabled, created_by, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING ${columns}`,
    [identity.organization_id, input.name, input.urlKey, input.httpMethod, input.draftCode, input.enabled, identity.user_id]);
    return result.rows[0];
  } catch (error) {
    if (error.constraint === 'dynamic_api_route_key') throw new HttpError(409, 'dynamic_api_route_exists', 'A dynamic API with this URL key and method already exists.');
    throw error;
  }
}

export async function updateDynamicApiDraft(client, identity, apiId, rawInput) {
  requirePermission(identity, 'dynamic_apis.manage'); const id = dynamicApiIdInput(apiId);
  const input = dynamicApiInput(rawInput, { partial: true });
  try {
    const result = await client.query(`UPDATE dynamic_apis SET name=$3, url_key=$4, http_method=$5, draft_code=$6, enabled=$7, revision=revision+1, updated_by=$8, updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND revision=$9 RETURNING ${columns}`,
    [identity.organization_id, id, input.name, input.urlKey, input.httpMethod, input.draftCode, input.enabled, identity.user_id, input.revision]);
    if (!result.rowCount) {
      const exists = await client.query('SELECT 1 FROM dynamic_apis WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
      throw exists.rowCount ? new HttpError(409, 'dynamic_api_changed', 'This dynamic API changed. Reload before saving.')
        : new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
    }
    return result.rows[0];
  } catch (error) {
    if (error.constraint === 'dynamic_api_route_key') throw new HttpError(409, 'dynamic_api_route_exists', 'A dynamic API with this URL key and method already exists.');
    throw error;
  }
}

export async function publishDynamicApi(client, identity, apiId, expectedRevision) {
  requirePermission(identity, 'dynamic_apis.manage'); const id = dynamicApiIdInput(apiId);
  const result = await client.query(`UPDATE dynamic_apis SET live_code=draft_code, published_by=$3, published_at=now(), revision=revision+1, updated_by=$3, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$4 RETURNING ${columns}`,
  [identity.organization_id, id, identity.user_id, expectedRevision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM dynamic_apis WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'dynamic_api_changed', 'This dynamic API changed. Reload before publishing.')
      : new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
  }
  return result.rows[0];
}

const tokenColumns = `id, api_id AS "apiId", label, created_by AS "createdBy", created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

export async function listDynamicApiTokens(client, identity, apiId) {
  requireRead(identity); const id = dynamicApiIdInput(apiId);
  const result = await client.query(`SELECT ${tokenColumns} FROM dynamic_api_tokens WHERE organization_id=$1 AND api_id=$2 ORDER BY created_at DESC`, [identity.organization_id, id]);
  return { items: result.rows };
}

// The raw token is returned only once, at creation — only its sha256 is ever stored.
export async function createDynamicApiToken(client, identity, apiId, rawInput) {
  requirePermission(identity, 'dynamic_apis.manage'); const id = dynamicApiIdInput(apiId);
  const input = dynamicApiTokenInput(rawInput);
  const api = await client.query('SELECT 1 FROM dynamic_apis WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!api.rowCount) throw new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
  const token = `dak_${randomBytes(32).toString('hex')}`;
  const row = (await client.query(`INSERT INTO dynamic_api_tokens(organization_id, api_id, label, token_hash, created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${tokenColumns}`,
    [identity.organization_id, id, input.label, hashToken(token), identity.user_id])).rows[0];
  return { ...row, token };
}

export async function revokeDynamicApiToken(client, identity, apiId, tokenId) {
  requirePermission(identity, 'dynamic_apis.manage'); const id = dynamicApiIdInput(apiId); const tid = uuid(tokenId, 'Token').toLowerCase();
  const result = await client.query(`UPDATE dynamic_api_tokens SET revoked_at=now() WHERE organization_id=$1 AND api_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING ${tokenColumns}`,
    [identity.organization_id, id, tid]);
  if (!result.rowCount) throw new HttpError(404, 'token_not_found', 'Token was not found or already revoked.');
  return result.rows[0];
}

// Deliberately runs on its own connection/transaction, never the caller's
// client — a failed or timed-out run's history must still be recorded even
// though the caller immediately re-throws afterward, which would otherwise
// roll back this insert along with everything else in that transaction.
async function recordInvocation(organizationId, { apiId, isTestRun, invokedBy, status, errorMessage, logOutput, durationMs }) {
  await transaction((recorder) => recorder.query('SELECT dynamic_api_record_invocation($1,$2,$3,$4,$5,$6,$7,$8)',
    [organizationId, apiId, isTestRun, status, errorMessage, logOutput?.slice(0, 20_000) ?? null, Math.round(durationMs), invokedBy]));
}

export async function testRunDynamicApi(client, identity, apiId, rawInput) {
  requirePermission(identity, 'dynamic_apis.manage'); const id = dynamicApiIdInput(apiId);
  const input = dynamicApiTestRunInput(rawInput);
  const api = await client.query('SELECT draft_code AS "draftCode" FROM dynamic_apis WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!api.rowCount) throw new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
  const startedAt = Date.now();
  try {
    const { result, logs } = await runDynamicApiCode({ code: api.rows[0].draftCode, input: input.input, timeoutMs: TIMEOUT_MS },
      (resource, args) => executeWhitelistedQuery(client, identity.organization_id, resource, args));
    await recordInvocation(identity.organization_id, { apiId: id, isTestRun: true, invokedBy: identity.user_id, status: 'succeeded', logOutput: logs, durationMs: Date.now() - startedAt });
    return { result, logs };
  } catch (error) {
    await recordInvocation(identity.organization_id, { apiId: id, isTestRun: true, invokedBy: identity.user_id,
      status: error.statusCode === 'timed_out' ? 'timed_out' : 'failed', errorMessage: error.message, logOutput: error.logs, durationMs: Date.now() - startedAt });
    throw new HttpError(422, error.statusCode === 'timed_out' ? 'dynamic_api_timed_out' : 'dynamic_api_execution_failed', error.message);
  }
}

export async function listDynamicApiInvocations(client, identity, apiId) {
  requireRead(identity); const id = dynamicApiIdInput(apiId);
  const result = await client.query(`SELECT id, is_test_run AS "isTestRun", status, error_message AS "errorMessage", log_output AS "logOutput",
    duration_ms AS "durationMs", invoked_by AS "invokedBy", invoked_at AS "invokedAt"
    FROM dynamic_api_invocations WHERE organization_id=$1 AND api_id=$2 ORDER BY invoked_at DESC LIMIT 50`, [identity.organization_id, id]);
  return { items: result.rows };
}

// The live dispatch path: authenticated by bearer token, not a user session.
// dynamic_api_authenticate is the sole entry point that can resolve a token
// without an existing app.organization_id/app.user_id context.
export async function invokeDynamicApi(client, rawToken, httpMethod, urlKey, requestInput) {
  if (typeof rawToken !== 'string' || !rawToken) throw new HttpError(401, 'invalid_token', 'A valid bearer token is required.');
  const authenticated = (await client.query('SELECT * FROM dynamic_api_authenticate($1)', [hashToken(rawToken)])).rows[0];
  if (!authenticated) throw new HttpError(401, 'invalid_token', 'A valid bearer token is required.');
  if (authenticated.http_method !== httpMethod || authenticated.url_key !== urlKey) throw new HttpError(404, 'dynamic_api_not_found', 'Dynamic API was not found.');
  if (!authenticated.enabled) throw new HttpError(409, 'dynamic_api_disabled', 'This dynamic API is currently disabled.');
  if (!authenticated.live_code) throw new HttpError(409, 'dynamic_api_not_published', 'This dynamic API has not been published yet.');
  const startedAt = Date.now();
  try {
    const { result, logs } = await runDynamicApiCode({ code: authenticated.live_code, input: requestInput, timeoutMs: TIMEOUT_MS },
      (resource, args) => executeWhitelistedQuery(client, authenticated.organization_id, resource, args));
    await recordInvocation(authenticated.organization_id, { apiId: authenticated.api_id, isTestRun: false, invokedBy: null, status: 'succeeded', logOutput: logs, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await recordInvocation(authenticated.organization_id, { apiId: authenticated.api_id, isTestRun: false, invokedBy: null,
      status: error.statusCode === 'timed_out' ? 'timed_out' : 'failed', errorMessage: error.message, logOutput: error.logs, durationMs: Date.now() - startedAt });
    throw new HttpError(error.statusCode === 'timed_out' ? 504 : 502, error.statusCode === 'timed_out' ? 'dynamic_api_timed_out' : 'dynamic_api_execution_failed', error.message);
  }
}
