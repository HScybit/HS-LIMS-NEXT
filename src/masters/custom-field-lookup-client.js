import { loadCustomFieldLookupSources } from '../custom-fields/lookup-client.js';

export function loadMasterFieldLookupSources(kind, fields, previous, options) {
  const resource = kind === 'product' ? 'products' : kind === 'parameter' ? 'test-parameters' : kind === 'method' ? 'methods' : kind === 'customer' ? 'customers' : null;
  if (!resource) throw new TypeError('Unsupported lookup field master.');
  return loadCustomFieldLookupSources(fields, `/api/masters/${resource}/custom-fields/lookup-options`, previous, options);
}
