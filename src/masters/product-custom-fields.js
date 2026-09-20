import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from './master-custom-field-values.js';

export const loadProductCustomFieldValues = (...args) => loadMasterCustomFieldValues('product', ...args);
export const prepareProductCustomFieldValues = (...args) => prepareMasterCustomFieldValues('product', ...args);
export const appendProductCustomFieldValues = (...args) => appendMasterCustomFieldValues('product', ...args);
