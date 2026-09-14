import { createHmac } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer } from '../templates/input.js';
import { userAccountInput } from './account-input.js';
import { userProfileInput } from './profile-input.js';
import { userCustomFieldInput } from './custom-field-input.js';

const accountFields = ['requestId', 'revision', 'username', 'email', 'displayName', 'password'];
const profileFields = ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId', 'roleIds'];

export function userFormInput(userId, value) {
  fieldsOnly(value, [...accountFields, 'profileRevision', ...profileFields, 'customFields', 'customFieldRevision', 'customFieldTimeZone']);
  const profileRevision = integer(value.profileRevision, 'Profile revision', 0, 2_147_483_646);
  const { id, ...account } = userAccountInput(userId, Object.fromEntries(accountFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  const changes = Object.fromEntries(profileFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const profile = Object.keys(changes).length ? userProfileInput({ requestId: account.requestId, revision: profileRevision, ...changes }) : null;
  const suppliedFields = Object.hasOwn(value, 'customFields');
  if (!suppliedFields && ['customFieldRevision', 'customFieldTimeZone'].some(key => Object.hasOwn(value, key))) {
    throw new HttpError(400, 'invalid_custom_field_values', 'A Custom Field revision or time zone requires supplied fields.');
  }
  const fieldCapture = suppliedFields ? userCustomFieldInput(id, { requestId: account.requestId, revision: value.customFieldRevision,
    customFields: value.customFields, customFieldTimeZone: value.customFieldTimeZone }) : null;
  // The account command's public input uses blank for an unchanged password.
  return { id, account: { ...account, password: account.password ?? '' }, profile, ...(fieldCapture ? { fieldCapture } : {}) };
}

export function userFormFingerprint(input, key = process.env.MFA_ENCRYPTION_KEY) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'account_command_key_unavailable', 'Account editing is temporarily unavailable.');
  const commandKey = createHmac('sha256', Buffer.from(key, 'hex')).update('SampleifyLIMS/user-form/key/v1').digest();
  return createHmac('sha256', commandKey).update(JSON.stringify(input), 'utf8').digest();
}
