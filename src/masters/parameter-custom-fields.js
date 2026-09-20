import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from './master-custom-field-values.js';

export const loadParameterCustomFieldValues = (...args) => loadMasterCustomFieldValues('parameter', ...args);
export const prepareParameterCustomFieldValues = (...args) => prepareMasterCustomFieldValues('parameter', ...args);
export const appendParameterCustomFieldValues = (...args) => appendMasterCustomFieldValues('parameter', ...args);
