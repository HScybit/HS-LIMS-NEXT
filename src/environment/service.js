import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid } from '../templates/input.js';
import { environmentDataInput } from './input.js';

const columns = `id, laboratory_id AS "laboratoryId", recorded_at AS "recordedAt", temperature_celsius AS "temperatureCelsius",
  relative_humidity_percent AS "relativeHumidityPercent", revision, recorded_by AS "recordedBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['environment_data.read', 'environment_data.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view environmental monitoring readings.');
  }
}

// A configured limit that cannot be parsed as a number surfaces as a hard
// error instead of being silently skipped: laboratories.minimum/maximum
// Temperature/Humidity are free text preserving Meteor's raw values, and bad
// legacy data there must not quietly disable the safety check it configures.
function parseLimit(value, label) {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new HttpError(409, 'invalid_laboratory_limit', `The laboratory's configured ${label} is not a valid number. Correct it before recording readings.`);
  return parsed;
}

async function assertWithinLimits(client, organizationId, input) {
  const laboratory = (await client.query('SELECT minimum_temperature_text, maximum_temperature_text, minimum_humidity_text, maximum_humidity_text FROM laboratories WHERE organization_id=$1 AND id=$2',
    [organizationId, input.laboratoryId])).rows[0];
  if (!laboratory) throw new HttpError(404, 'laboratory_not_found', 'Laboratory was not found.');
  const minTemperature = parseLimit(laboratory.minimum_temperature_text, 'minimum temperature');
  const maxTemperature = parseLimit(laboratory.maximum_temperature_text, 'maximum temperature');
  const minHumidity = parseLimit(laboratory.minimum_humidity_text, 'minimum humidity');
  const maxHumidity = parseLimit(laboratory.maximum_humidity_text, 'maximum humidity');
  if (input.temperatureCelsius !== null) {
    const value = Number(input.temperatureCelsius);
    if ((minTemperature !== null && value < minTemperature) || (maxTemperature !== null && value > maxTemperature)) {
      throw new HttpError(422, 'temperature_out_of_range', 'The recorded temperature is outside the laboratory\'s configured range.');
    }
  }
  if (input.relativeHumidityPercent !== null) {
    const value = Number(input.relativeHumidityPercent);
    if ((minHumidity !== null && value < minHumidity) || (maxHumidity !== null && value > maxHumidity)) {
      throw new HttpError(422, 'humidity_out_of_range', 'The recorded relative humidity is outside the laboratory\'s configured range.');
    }
  }
}

export async function listEnvironmentData(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${columns} FROM environment_data WHERE organization_id=$1 ORDER BY recorded_at DESC, id`, [identity.organization_id]);
  return { items: result.rows };
}

export async function getEnvironmentData(client, identity, recordId) {
  requireRead(identity); const id = uuid(recordId, 'Environment reading').toLowerCase();
  const result = await client.query(`SELECT ${columns} FROM environment_data WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'environment_reading_not_found', 'Environment reading was not found.');
  return result.rows[0];
}

export async function createEnvironmentData(client, identity, rawInput) {
  requirePermission(identity, 'environment_data.manage');
  const input = environmentDataInput(rawInput);
  await assertWithinLimits(client, identity.organization_id, input);
  const result = await client.query(`INSERT INTO environment_data(organization_id, laboratory_id, recorded_at, temperature_celsius, relative_humidity_percent, recorded_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
  [identity.organization_id, input.laboratoryId, input.recordedAt, input.temperatureCelsius, input.relativeHumidityPercent, identity.user_id]);
  return result.rows[0];
}

export async function updateEnvironmentData(client, identity, recordId, rawInput) {
  requirePermission(identity, 'environment_data.manage'); const id = uuid(recordId, 'Environment reading').toLowerCase();
  const input = environmentDataInput(rawInput, { partial: true });
  await assertWithinLimits(client, identity.organization_id, input);
  const result = await client.query(`UPDATE environment_data SET laboratory_id=$3, recorded_at=$4, temperature_celsius=$5, relative_humidity_percent=$6, revision=revision+1, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$7 RETURNING ${columns}`,
  [identity.organization_id, id, input.laboratoryId, input.recordedAt, input.temperatureCelsius, input.relativeHumidityPercent, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM environment_data WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'environment_reading_changed', 'This reading changed. Reload before saving.')
      : new HttpError(404, 'environment_reading_not_found', 'Environment reading was not found.');
  }
  return result.rows[0];
}

export async function deleteEnvironmentData(client, identity, recordId, expectedRevision) {
  requirePermission(identity, 'environment_data.manage'); const id = uuid(recordId, 'Environment reading').toLowerCase();
  const result = await client.query('DELETE FROM environment_data WHERE organization_id=$1 AND id=$2 AND revision=$3', [identity.organization_id, id, expectedRevision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM environment_data WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'environment_reading_changed', 'This reading changed. Reload before deleting.')
      : new HttpError(404, 'environment_reading_not_found', 'Environment reading was not found.');
  }
}

// Meteor surfaces this as an in-app "pending items" alert, not email; no
// notification/delivery infrastructure exists in this codebase yet, so this
// stays a queryable computation rather than a background job. A lab is
// "missed" for a scan window if it operates during that window (per its
// organization's configured hours) and has no reading inside the preceding
// interval.
export async function laboratoriesMissingReadings(client, identity, { asOf = new Date() } = {}) {
  requireRead(identity);
  const settings = (await client.query('SELECT operating_start_time, operating_end_time, environment_data_interval_minutes FROM organization_laboratory_settings WHERE organization_id=$1',
    [identity.organization_id])).rows[0];
  if (!settings?.environment_data_interval_minutes) return { items: [], intervalConfigured: false };
  const result = await client.query(`SELECT laboratory.id, laboratory.name, latest.recorded_at AS "lastRecordedAt"
    FROM laboratories laboratory LEFT JOIN LATERAL (
      SELECT recorded_at FROM environment_data reading WHERE reading.organization_id=laboratory.organization_id AND reading.laboratory_id=laboratory.id
      ORDER BY reading.recorded_at DESC LIMIT 1) latest ON true
    WHERE laboratory.organization_id=$1
      AND ($2::timestamptz - make_interval(mins => $3) > coalesce(latest.recorded_at, '-infinity'::timestamptz))
      AND ($4::time IS NULL OR $5::time IS NULL OR $2::time BETWEEN $4::time AND $5::time)
    ORDER BY laboratory.name`,
  [identity.organization_id, asOf, settings.environment_data_interval_minutes, settings.operating_start_time, settings.operating_end_time]);
  return { items: result.rows, intervalConfigured: true };
}
