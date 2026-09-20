import { masterCustomFieldMatch, loadMasterListingValues } from './master-custom-field-listing.js';

export const methodCustomFieldMatch = (...args) => masterCustomFieldMatch('method', ...args);
export const loadMethodListingValues = (...args) => loadMasterListingValues('method', ...args);
