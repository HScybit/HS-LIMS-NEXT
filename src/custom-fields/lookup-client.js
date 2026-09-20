import { apiRequest } from '../lib/api-client.js';
import { prepareSelectOptions } from '../components/ui/selectUtils.js';

export async function loadCustomFieldLookupSources(fields, endpoint, previous = new Map(), { signal, request = apiRequest, organizationId } = {}) {
  const ids = [...new Set(fields.filter(field => field.fieldType === 'lookup' && field.lookupSourceId).map(field => field.lookupSourceId))];
  const sources = new Map();
  for (let start = 0; start < ids.length; start += 4) {
    signal?.throwIfAborted();
    const batch = await Promise.all(ids.slice(start, start + 4).map(async sourceId => {
      const prior = previous.get(sourceId);
      const result = await request(`${endpoint}?sourceId=${encodeURIComponent(sourceId)}${prior?.revision ? `&revision=${prior.revision}&knownOrganizationId=${encodeURIComponent(prior.organizationId)}` : ''}`, { signal });
      if (organizationId !== undefined && result.organizationId !== organizationId || result.sourceId !== sourceId
        || result.unchanged && (!prior || result.organizationId !== prior.organizationId || result.revision !== prior.revision)
        || !result.unchanged && !Array.isArray(result.options)) throw new Error('Lookup choices changed. Reload before continuing.');
      return [sourceId, result.unchanged ? prior : { organizationId: result.organizationId, revision: result.revision,
        options: result.options, selectOptions: prepareSelectOptions(result.options) }];
    }));
    signal?.throwIfAborted();
    for (const [sourceId, source] of batch) sources.set(sourceId, source);
  }
  return sources;
}
