import { masterCustomFieldMatch, loadMasterListingValues } from './master-custom-field-listing.js';

export const parameterCustomFieldMatch = (...args) => masterCustomFieldMatch('parameter', ...args);
export const loadParameterListingValues = (...args) => loadMasterListingValues('parameter', ...args);
