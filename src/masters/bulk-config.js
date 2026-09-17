import { userBulkHeaders } from '../users/bulk-input.js';
import { customerBulkHeaders } from './customer-bulk-config.js';
import { customerFormFields } from './customer-fields.js';

export const masterBulkResources = Object.freeze({
  products: { permission: 'masters.manage', label: 'Products', path: '/products', key: 'key', required: ['key'],
    headers: ['name', 'key', 'description', 'abbr'],
    fields: ['name', 'key', 'description', 'abbreviation', 'jobTemplateId', 'tagIds'] },
  'test-parameters': { permission: 'masters.manage', label: 'Parameters', path: '/test_parameters', key: 'key', required: ['name', 'key', 'schemeAbbreviation'],
    headers: ['name', 'key', 'scheme_abbr', 'description', 'order', 'lab'],
    fields: ['name', 'key', 'schemeAbbreviation', 'description', 'order', 'laboratoryId', 'measurementUncertainty'] },
  methods: { permission: 'masters.manage', label: 'Method of Analysis', path: '/method_of_analysis', key: 'uuid', required: ['name', 'uuid', 'parseNumber'],
    headers: ['name', 'uuid', 'parse_num', 'description', 'decimal_places', 'user_access'],
    fields: ['name', 'uuid', 'description', 'decimalScale', 'parseNumber', 'accessUserIds'] },
  users: { permission: 'users.manage', label: 'Users', path: '/user_management', headers: userBulkHeaders },
  customers: { permission: 'masters.manage', module: 'customer', label: 'Customer', path: '/customer_masters', key: 'name', required: ['name', 'legalName'],
    headers: customerBulkHeaders, fields: customerFormFields.map(field => field.key) },
});

export const allowedMasterBulkResources = (permissions = [], modules = {}) => Object.entries(masterBulkResources)
  .filter(([, config]) => permissions.includes(config.permission) && (!config.module || modules[config.module])).map(([resource]) => resource);

export const masterBulkChunkSize = 25;
export const masterBulkPageSize = 50;
