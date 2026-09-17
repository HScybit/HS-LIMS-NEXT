export const masterBulkResources = Object.freeze({
  products: { label: 'Products', path: '/products', key: 'key', required: ['key'],
    headers: ['name', 'key', 'description', 'abbr'],
    fields: ['name', 'key', 'description', 'abbreviation', 'jobTemplateId', 'tagIds'] },
  'test-parameters': { label: 'Parameters', path: '/test_parameters', key: 'key', required: ['name', 'key', 'schemeAbbreviation'],
    headers: ['name', 'key', 'scheme_abbr', 'description', 'order', 'lab'],
    fields: ['name', 'key', 'schemeAbbreviation', 'description', 'order', 'laboratoryId', 'measurementUncertainty'] },
  methods: { label: 'Method of Analysis', path: '/method_of_analysis', key: 'uuid', required: ['name', 'uuid', 'parseNumber'],
    headers: ['name', 'uuid', 'parse_num', 'description', 'decimal_places', 'user_access'],
    fields: ['name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds'] },
});

export const masterBulkChunkSize = 25;
export const masterBulkPageSize = 50;
