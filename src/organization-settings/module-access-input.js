import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, uuid } from '../templates/input.js';

export const moduleAccessDefinitions = Object.freeze([
  Object.freeze({ key: 'customer', label: 'Customer Master' }),
  Object.freeze({ key: 'vendor', label: 'Vendor Master' }),
  Object.freeze({ key: 'instrument', label: 'Instrument Management' }),
  Object.freeze({ key: 'service_agreements', label: 'Service Agreements' }),
]);
export const moduleAccessSelectionLimit = 500;

export function moduleAccessSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_module_access', 'Provide organization settings as an object.');
  }
  if (!Object.hasOwn(input, 'moduleAccess')) return null;
  if (!Array.isArray(input.moduleAccess) || ![2, 3, 4].includes(input.moduleAccess.length)) {
    throw new HttpError(400, 'invalid_module_access', 'Provide Customer and Vendor access settings together.');
  }
  const modules = new Map();
  for (const row of input.moduleAccess) {
    fieldsOnly(row, ['moduleKey', 'enabled', 'roleIds', 'userIds']);
    if (!moduleAccessDefinitions.some(module => module.key === row.moduleKey) || modules.has(row.moduleKey)) {
      throw new HttpError(400, 'invalid_module_access', 'Provide each supported module exactly once.');
    }
    const selections = {};
    for (const [key, label] of [['roleIds', 'Role'], ['userIds', 'User']]) {
      if (!Array.isArray(row[key]) || row[key].length > moduleAccessSelectionLimit) {
        throw new HttpError(400, 'invalid_module_access', `Select at most ${moduleAccessSelectionLimit} ${label.toLowerCase()}s per module.`);
      }
      const ids = Array.from(row[key], value => uuid(value, label).toLowerCase());
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_module_access', `${label} selections must be unique within each module.`);
      selections[key] = ids;
    }
    modules.set(row.moduleKey, { moduleKey: row.moduleKey, enabled: bool(row.enabled, 'Module enabled'), ...selections });
  }
  if (!moduleAccessDefinitions.slice(0, modules.size).every(module => modules.has(module.key))) {
    throw new HttpError(400, 'invalid_module_access', 'Provide the complete supported module settings together.');
  }
  // Older clients omit newer modules. The native command preserves their last
  // saved assignments while capturing the explicitly supplied settings.
  return moduleAccessDefinitions.filter(module => modules.has(module.key)).map(module => modules.get(module.key));
}
