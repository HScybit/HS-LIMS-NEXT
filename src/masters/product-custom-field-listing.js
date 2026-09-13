import { masterCustomFieldMatch, loadMasterListingValues } from './master-custom-field-listing.js';

export const productCustomFieldMatch = (...args) => masterCustomFieldMatch('product', ...args);
export const loadProductListingValues = (...args) => loadMasterListingValues('product', ...args);
