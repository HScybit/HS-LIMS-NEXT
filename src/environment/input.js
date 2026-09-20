import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, decimal } from '../templates/input.js';
import { sampleTimestamp } from '../samples/input.js';

export function environmentDataInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'laboratoryId', 'recordedAt', 'temperatureCelsius', 'relativeHumidityPercent']);
  const laboratoryId = uuid(input.laboratoryId, 'Laboratory').toLowerCase();
  const recordedAt = sampleTimestamp(input.recordedAt, 'Recorded at');
  const temperatureCelsius = input.temperatureCelsius == null ? null : decimal(input.temperatureCelsius, 'Temperature');
  const relativeHumidityPercent = input.relativeHumidityPercent == null ? null : decimal(input.relativeHumidityPercent, 'Relative humidity');
  if (temperatureCelsius === null && relativeHumidityPercent === null) throw new HttpError(400, 'invalid_environment_reading', 'Temperature or relative humidity is required.');
  if (temperatureCelsius !== null && (Number(temperatureCelsius) < -100 || Number(temperatureCelsius) > 200)) throw new HttpError(400, 'invalid_environment_reading', 'Temperature must be between -100 and 200.');
  if (relativeHumidityPercent !== null && (Number(relativeHumidityPercent) < 0 || Number(relativeHumidityPercent) > 100)) throw new HttpError(400, 'invalid_environment_reading', 'Relative humidity must be between 0 and 100.');
  return { laboratoryId, recordedAt, temperatureCelsius, relativeHumidityPercent,
    ...(partial ? { revision: integer(input.revision, 'Environment reading revision', 1, 2_147_483_647) } : {}) };
}
