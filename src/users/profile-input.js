import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, integer, text, uuid } from '../templates/input.js';

const profileFields = ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId', 'roleIds'];
const optionalText = (value, label, maximum) => {
  const result = text(value, label, maximum, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_user_profile_text', `${label} contains invalid text.`);
  return result || null;
};

export function userProfileInput(input) {
  fieldsOnly(input, ['requestId', 'revision', ...profileFields]);
  if (!profileFields.some((field) => Object.hasOwn(input, field))) throw new HttpError(400, 'empty_user_profile', 'Include a profile change.');
  const result = { requestId: uuid(input.requestId, 'Save request').toLowerCase(), revision: integer(input.revision, 'Profile revision', 0, 2_147_483_646) };
  for (const [field, label, maximum] of [['employeeCode', 'Employee code', 100], ['phone', 'Contact number', 50], ['designation', 'Designation', 150]]) {
    if (Object.hasOwn(input, field)) result[field] = optionalText(input[field], label, maximum);
  }
  if (Object.hasOwn(input, 'canManagePeople')) result.canManagePeople = bool(input.canManagePeople, 'Can be Manager');
  for (const [field, label, nullable] of [['businessUnitId', 'Business unit', true], ['defaultRoleId', 'Default role', false],
    ['laboratoryId', 'Laboratory', false], ['reportingManagerId', 'Reporting manager', true]]) {
    if (Object.hasOwn(input, field)) result[field] = nullable && input[field] === null ? null : uuid(input[field], label).toLowerCase();
  }
  if (Object.hasOwn(input, 'roleIds')) {
    if (!Array.isArray(input.roleIds) || input.roleIds.length < 1 || input.roleIds.length > 100) throw new HttpError(400, 'invalid_user_roles', 'Select 1 to 100 roles.');
    const roles = input.roleIds.map((roleId) => uuid(roleId, 'Role').toLowerCase());
    if (new Set(roles).size !== roles.length) throw new HttpError(400, 'duplicate_user_roles', 'Select each role once.');
    result.roleIds = roles.sort();
  }
  return result;
}
