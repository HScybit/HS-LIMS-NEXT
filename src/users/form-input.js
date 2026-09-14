import { fieldsOnly, integer } from '../templates/input.js';
import { userAccountInput } from './account-input.js';
import { userProfileInput } from './profile-input.js';

const accountFields = ['requestId', 'revision', 'username', 'email', 'displayName', 'password'];
const profileFields = ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId', 'roleIds'];

export function userFormInput(userId, value) {
  fieldsOnly(value, [...accountFields, 'profileRevision', ...profileFields]);
  const profileRevision = integer(value.profileRevision, 'Profile revision', 0, 2_147_483_646);
  const { id, ...account } = userAccountInput(userId, Object.fromEntries(accountFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  const changes = Object.fromEntries(profileFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const profile = Object.keys(changes).length ? userProfileInput({ requestId: account.requestId, revision: profileRevision, ...changes }) : null;
  // The account command's public input uses blank for an unchanged password.
  return { id, account: { ...account, password: account.password ?? '' }, profile };
}
