import { loadCustomFieldLookupSources } from '../custom-fields/lookup-client.js';

export function loadUserFieldLookupSources(fields, previous, options) {
  return loadCustomFieldLookupSources(fields, '/api/users/custom-fields/lookup-options', previous, options);
}
