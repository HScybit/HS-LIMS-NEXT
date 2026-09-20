import { loadMasterCustomFieldValues, prepareMasterCustomFieldValues, appendMasterCustomFieldValues } from './master-custom-field-values.js';
import { HttpError } from '../auth/errors.js';

export async function lockMethodCustomFieldCapture(client) {
  try { await client.query('SELECT masters_lock_method_field_writer()'); }
  catch (error) {
    if (error.code === '42501' && error.constraint === 'master_field_session_required') {
      throw new HttpError(403, 'forbidden', 'An active master management session is required.');
    }
    if (error.code === '25001' && error.constraint === 'method_field_write_isolation') {
      throw new HttpError(409, 'method_field_write_isolation', 'Method saves require a current transaction snapshot.');
    }
    throw error;
  }
}

export const loadMethodCustomFieldValues = (...args) => loadMasterCustomFieldValues('method', ...args);
export const prepareMethodCustomFieldValues = (...args) => prepareMasterCustomFieldValues('method', ...args);
export const appendMethodCustomFieldValues = (...args) => appendMasterCustomFieldValues('method', ...args);
