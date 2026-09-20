import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, text } from '../templates/input.js';

const urlKeyPattern = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/;
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function dynamicApiInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'name', 'urlKey', 'httpMethod', 'draftCode', 'enabled']);
  const name = text(input.name, 'Name', 200);
  const urlKey = typeof input.urlKey === 'string' ? input.urlKey.trim().toLowerCase() : '';
  if (!urlKeyPattern.test(urlKey)) throw new HttpError(400, 'invalid_url_key', 'The URL key must be lowercase letters, digits and hyphens, starting and ending with a letter or digit.');
  if (!httpMethods.includes(input.httpMethod)) throw new HttpError(400, 'invalid_http_method', 'Select a supported HTTP method.');
  const draftCode = text(input.draftCode, 'Code', 65536);
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'invalid_input', 'Enabled must be true or false.');
  return { name, urlKey, httpMethod: input.httpMethod, draftCode, enabled,
    ...(partial ? { revision: integer(input.revision, 'Dynamic API revision', 1, 2_147_483_647) } : {}) };
}

export function dynamicApiTestRunInput(input) {
  fieldsOnly(input, ['input']);
  if (input.input !== undefined && (typeof input.input !== 'object' || input.input === null || Array.isArray(input.input))) {
    throw new HttpError(400, 'invalid_input', 'Test input must be a plain object.');
  }
  return { input: input.input ?? {} };
}

export function dynamicApiTokenInput(input) {
  fieldsOnly(input, ['label']);
  return { label: input.label == null || input.label === '' ? null : text(input.label, 'Label', 200) };
}

export { httpMethods };
export const dynamicApiIdInput = (value) => uuid(value, 'Dynamic API').toLowerCase();
