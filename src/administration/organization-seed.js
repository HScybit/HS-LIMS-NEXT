import { randomUUID } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { withSession } from '../auth/service.js';
import { getPool } from '../db/pool.js';
import { seedDomains, seedDomainGroups, runDemoSeedProvisioning, DEFAULT_SEED_INDUSTRIES } from '../seed/run-demo-seed.js';
import { seedIndustriesInfo, SEED_INDUSTRY_KEYS, SEED_VERSION } from '../seed/industry-catalog.js';

// Counted to tell an administrator whether an organization already holds data,
// so a re-seed can be confirmed rather than applied silently.

async function requirePlatformAdministrator(client) {
  const result = await client.query('SELECT auth_is_platform_administrator() AS allowed');
  if (!result.rows[0].allowed) throw new HttpError(403, 'platform_administrator_required', 'Platform administrator access is required.');
}

async function loadOrganizationRow(client, organizationId) {
  const result = await client.query('SELECT id,code,name,status FROM organizations WHERE id=$1', [organizationId]);
  if (!result.rowCount) throw new HttpError(404, 'organization_not_found', 'Organization was not found.');
  return result.rows[0];
}

// The seeding pipeline runs through the real service layer, which means it needs
// a session belonging to the target organization's administrator — row-level
// security is driven by the session context, so there is no way to write as
// them without one. The session is short-lived and revoked once the run ends.
async function seedSession(identity, organizationId, requestedUserId = null) {
  const token = newToken();
  const csrfToken = newToken();
  // Minted outside the request transaction so the seeding work, which runs on
  // its own connections, can see the session immediately.
  const created = await getPool().query(
    `SELECT user_id AS "userId", restore_password_change AS "restorePasswordChange"
     FROM platform_create_seed_session($1,$2,$3,$4,$5,$6)`,
    [identity.organization_id, identity.user_id, organizationId, hashToken(token), hashToken(csrfToken), requestedUserId]);
  if (!created.rowCount) return null;
  return { token, csrfToken, userId: created.rows[0].userId, restorePasswordChange: created.rows[0].restorePasswordChange };
}

async function administratorSession(identity, organizationId) {
  const session = await seedSession(identity, organizationId);
  if (!session) throw new HttpError(409, 'organization_has_no_administrator', 'This organization has no active administrator to seed as.');
  return session;
}

// The lifecycle stages past allocation belong to the analyst and the approver,
// so each is given a session of their own. Every one is revoked when the run
// ends, whether it succeeded or not.
function seedSessionPool(identity, organizationId) {
  const sessions = new Map();
  const open = async (userId) => {
    if (!sessions.has(userId)) {
      const session = await seedSession(identity, organizationId, userId);
      sessions.set(userId, session);
    }
    const session = sessions.get(userId);
    if (!session) return null;
    return (work) => withSession(session.token, work, { csrfToken: session.csrfToken, accountAction: true });
  };
  const closeAll = async () => {
    for (const session of sessions.values()) {
      if (!session) continue;
      await getPool().query('SELECT platform_end_seed_session($1,$2,$3,$4,$5)',
        [identity.organization_id, identity.user_id, session.userId, hashToken(session.token), session.restorePasswordChange]).catch(() => {});
    }
    sessions.clear();
  };
  return { open, closeAll };
}

export async function organizationSeedPlan(client, identity, organizationId) {
  await requirePlatformAdministrator(client);
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const organization = await loadOrganizationRow(client, id);
  const counts = await client.query(
    `SELECT members, laboratories, customers, vendors, products, methods,
            test_parameters AS "testParameters", templates, samples, instruments
     FROM platform_organization_seed_counts($1,$2,$3)`,
    [identity.organization_id, identity.user_id, id]);
  const lastRun = await client.query(
    `SELECT id,mode,status,started_at AS "startedAt",completed_at AS "completedAt",failure_message AS "failureMessage"
     FROM seed_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 1`, [id]);
  const existingData = counts.rows[0];
  return {
    organization,
    seedVersion: SEED_VERSION,
    industries: seedIndustriesInfo,
    defaultIndustries: DEFAULT_SEED_INDUSTRIES,
    generationOrder: seedDomains,
    domainGroups: seedDomainGroups,
    existingData,
    behavior: 'Seeding rebuilds the organization from the selected industry catalogs. The organization, its System Administrator role and the users holding it, and the seed-run history are preserved; every other record in this organization is removed first.',
    // A fresh organization always has its administrator, so the confirmation
    // is driven by the domains seeding actually creates.
    hasExistingData: Object.entries(existingData).some(([key, count]) => key !== 'members' && count > 0),
    lastRun: lastRun.rows[0] ?? null,
  };
}

export async function listOrganizationSeedRuns(client, identity, organizationId) {
  await requirePlatformAdministrator(client);
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const runs = await client.query(
    `SELECT id,mode,status,started_at AS "startedAt",completed_at AS "completedAt",failure_message AS "failureMessage"
     FROM seed_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 20`, [id]);
  return { items: runs.rows };
}

// Run history is written through the seeded session rather than the platform
// administrator's request transaction: each write is then its own transaction,
// so progress is durable as it happens and a failure record survives the error
// that produced it. The rows stay scoped to the organization being seeded; the
// administrator who triggered the run is recorded in the actor columns.
function seedWrite(session, work) {
  return withSession(session.token, work, { csrfToken: session.csrfToken, accountAction: true });
}

async function recordRun(session, values) {
  await seedWrite(session, (client) => client.query(
    `INSERT INTO seed_runs(organization_id,id,mode,status,actor_organization_id,actor_user_id)
     VALUES($1,$2,$3,'running',$4,$5)`,
    [values.organizationId, values.runId, values.mode, values.actorOrganizationId, values.actorUserId]));
}

async function completeRun(session, runId, status, failureMessage = null) {
  await seedWrite(session, (client) => client.query(
    'UPDATE seed_runs SET status=$2, completed_at=now(), failure_message=$3 WHERE id=$1',
    [runId, status, failureMessage]));
}

async function recordStep(session, organizationId, runId, position, domainKey, status, message = null) {
  await seedWrite(session, (client) => client.query(
    'INSERT INTO seed_run_steps(organization_id,run_id,position,domain_key,status,message) VALUES($1,$2,$3,$4,$5,$6)',
    [organizationId, runId, position, domainKey, status, message]));
}

function requestedIndustries(rawInput) {
  if (rawInput.industries === undefined) return [...DEFAULT_SEED_INDUSTRIES];
  if (!Array.isArray(rawInput.industries)) throw new HttpError(400, 'invalid_input', 'Select the laboratory industries to seed.');
  const chosen = [...new Set(rawInput.industries)];
  if (!chosen.length) throw new HttpError(400, 'invalid_input', 'Select at least one laboratory industry.');
  const unknown = chosen.filter((key) => !SEED_INDUSTRY_KEYS.includes(key));
  if (unknown.length) throw new HttpError(400, 'invalid_input', `Unsupported laboratory industry: ${unknown.join(', ')}.`);
  // Ordered as the catalog publishes them so a run is reproducible.
  return SEED_INDUSTRY_KEYS.filter((key) => chosen.includes(key));
}

export async function organizationSeedProgress(client, identity, organizationId, runId) {
  await requirePlatformAdministrator(client);
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const run = uuid(runId, 'Seed run').toLowerCase();
  const found = (await client.query(
    `SELECT id,mode,status,started_at AS "startedAt",completed_at AS "completedAt",failure_message AS "failureMessage"
     FROM seed_runs WHERE organization_id=$1 AND id=$2`, [id, run])).rows[0];
  // The run row is written moments after the request is accepted, so a caller
  // polling from the instant it posted sees the run as pending rather than
  // missing. Its own request settling is what ends the wait.
  if (!found) {
    return { runId: run, status: 'pending', mode: null, completedSteps: 0, totalSteps: seedDomains.length, percent: 0, steps: [], currentDomain: null };
  }
  const steps = (await client.query(
    `SELECT position,domain_key AS "domainKey",status,message FROM seed_run_steps
     WHERE organization_id=$1 AND run_id=$2 ORDER BY position`, [id, run])).rows;
  // A re-seed clears the organization first, which is a step of its own.
  const totalSteps = seedDomains.length + (found.mode === 'reseed' ? 1 : 0);
  const completedSteps = steps.filter((step) => step.status === 'succeeded').length;
  const percent = found.status === 'succeeded' ? 100 : Math.min(99, Math.round((completedSteps / totalSteps) * 100));
  const offset = found.mode === 'reseed' ? 1 : 0;
  return {
    ...found, runId: run, totalSteps, completedSteps, percent, steps,
    // What is being worked on now: the domain after the last one that finished.
    currentDomain: found.status === 'running'
      ? seedDomains[Math.max(0, completedSteps - offset)]?.label ?? null
      : null,
  };
}

export async function runOrganizationSeed(client, identity, organizationId, rawInput = {}) {
  await requirePlatformAdministrator(client);
  const industries = requestedIndustries(rawInput);
  const runId = rawInput.runId === undefined ? randomUUID() : uuid(rawInput.runId, 'Seed run').toLowerCase();
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const organization = await loadOrganizationRow(client, id);
  const plan = await organizationSeedPlan(client, identity, id);
  const mode = plan.hasExistingData ? 'reseed' : 'fresh';
  if (mode === 'reseed' && String(rawInput.confirmation ?? '').trim() !== organization.name) {
    throw new HttpError(400, 'seed_confirmation_required', 'Type the organization name exactly to confirm re-seeding an organization that already holds data.');
  }
  const running = await client.query("SELECT 1 FROM seed_runs WHERE organization_id=$1 AND status='running' LIMIT 1", [id]);
  if (running.rowCount) throw new HttpError(409, 'seed_already_running', 'A seeding run is already in progress for this organization.');

  if ((await client.query('SELECT 1 FROM seed_runs WHERE organization_id=$1 AND id=$2', [id, runId])).rowCount) {
    throw new HttpError(409, 'seed_run_reused', 'This seeding run identifier was already used.');
  }

  const session = await administratorSession(identity, id);
  const pool = seedSessionPool(identity, id);
  await recordRun(session, { organizationId: id, runId, mode, actorOrganizationId: identity.organization_id, actorUserId: identity.user_id });
  const steps = [];
  try {
    // Re-seeding rebuilds the organization rather than layering a second
    // demonstration set on top of the first, so it is emptied first. The
    // organization, its administrators and this run's own history survive.
    if (mode === 'reseed') {
      const reset = await getPool().query('SELECT passes, rows_deleted AS "rowsDeleted" FROM platform_reset_organization_data($1,$2,$3)',
        [identity.organization_id, identity.user_id, id]);
      steps.push({ domainKey: 'reset', status: 'succeeded' });
      await recordStep(session, id, runId, steps.length, 'reset', 'succeeded',
        `Removed ${reset.rows[0].rowsDeleted} records in ${reset.rows[0].passes} passes, preserving the organization and its administrators.`);
    }
    const provisioned = await runDemoSeedProvisioning(session, {
      accountAction: true, industries, sessionFor: pool.open,
      onStep: async (label) => {
        steps.push({ domainKey: label, status: 'succeeded' });
        await recordStep(session, id, runId, steps.length, label, 'succeeded');
      },
    });
    await completeRun(session, runId, 'succeeded');
    const samples = provisioned?.samples ?? [];
    return { runId, mode, status: 'succeeded', steps, organization, industries,
      credentials: provisioned?.credentials ?? [],
      samples: samples.length,
      testRequests: samples.reduce((total, sample) => total + sample.testRequests.length, 0),
      lifecycle: provisioned?.lifecycle ?? null,
      // A scenario whose test requests could not be generated still leaves a
      // usable sample behind, so the run succeeds and reports what was skipped.
      incomplete: samples.filter((sample) => sample.testRequestError)
        .map((sample) => ({ scenario: sample.scenario, reason: sample.testRequestError })) };
  } catch (error) {
    const failed = seedDomains[steps.length - (mode === 'reseed' ? 1 : 0)]?.key ?? 'unknown';
    await recordStep(session, id, runId, steps.length + 1, failed, 'failed', error.message).catch(() => {});
    await completeRun(session, runId, 'failed', error.message).catch(() => {});
    throw new HttpError(400, 'seed_failed', `Seeding stopped at "${failed}": ${error.message}`);
  } finally {
    await pool.closeAll();
    await getPool().query('SELECT platform_end_seed_session($1,$2,$3,$4,$5)',
      [identity.organization_id, identity.user_id, session.userId, hashToken(session.token), session.restorePasswordChange]).catch(() => {});
  }
}
