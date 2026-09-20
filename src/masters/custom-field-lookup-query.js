import { HttpError } from '../auth/errors.js';

export function masterFieldLookupQuery(query) {
  if (query.size > 3 || query.getAll('sourceId').length !== 1 || query.getAll('revision').length > 1 || query.getAll('knownOrganizationId').length > 1
    || [...query.keys()].some(key => !['sourceId', 'revision', 'knownOrganizationId'].includes(key))
    || query.has('revision') && !/^[1-9][0-9]{0,9}$/.test(query.get('revision'))) {
    throw new HttpError(400, 'invalid_master_field_query', 'Provide one lookup source and an optional known revision and organization.');
  }
  return { sourceId: query.get('sourceId'), ...(query.has('revision') ? { revision: Number(query.get('revision')) } : {}),
    ...(query.has('knownOrganizationId') ? { knownOrganizationId: query.get('knownOrganizationId') } : {}) };
}
