import { createHmac } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text, uuid } from '../templates/input.js';
import { userProfileInput } from './profile-input.js';
import { userCustomFieldInput } from './custom-field-input.js';

const profileFields = ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId', 'roleIds'];
function identityText(value, label, maximum) {
  const result = text(value, label, maximum).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_user_identity_text', `${label} contains invalid text.`);
  return result;
}

export function userCreationInput(value) {
  fieldsOnly(value, ['id', 'requestId', 'revision', 'username', 'email', 'displayName', 'password', ...profileFields, 'customFields', 'customFieldTimeZone']);
  const id = uuid(value.id, 'New user').toLowerCase();
  if (value.revision !== 0) throw new HttpError(400, 'invalid_user_creation_revision', 'New accounts start at revision zero.');
  const username = identityText(value.username, 'Username', 100); const email = identityText(value.email, 'Email', 320);
  const displayName = identityText(value.displayName, 'Name', 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
  if (typeof value.password !== 'string' || value.password.length < 8 || value.password.length > 200 || !value.password.isWellFormed()) {
    throw new HttpError(400, 'invalid_user_password', 'Password must contain 8 to 200 valid characters.');
  }
  if (!Object.hasOwn(value, 'defaultRoleId') || !Object.hasOwn(value, 'laboratoryId')) {
    throw new HttpError(422, 'user_profile_references_required', 'Choose a default role and laboratory for this profile.');
  }
  const profile = userProfileInput({ requestId: value.requestId, revision: 0,
    ...Object.fromEntries(profileFields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]])),
  });
  const suppliedFields = Object.hasOwn(value, 'customFields');
  if (!suppliedFields && Object.hasOwn(value, 'customFieldTimeZone')) throw new HttpError(400, 'invalid_custom_field_values', 'A Custom Field time zone requires supplied fields.');
  const fields = suppliedFields ? userCustomFieldInput(id, { requestId: profile.requestId, revision: 0,
    customFields: value.customFields, customFieldTimeZone: value.customFieldTimeZone }) : null;
  return { id, username, email, displayName, password: value.password, ...profile,
    ...(fields ? { customFields: fields.customFields, customFieldTimeZone: fields.customFieldTimeZone } : {}) };
}

export function userCreationFingerprint(value, key = process.env.MFA_ENCRYPTION_KEY) {
  const input = userCreationInput(value);
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new HttpError(503, 'account_command_key_unavailable', 'Account creation is temporarily unavailable.');
  // Separate the command authentication key from the MFA encryption key. Never persist an unkeyed password digest.
  const commandKey = createHmac('sha256', Buffer.from(key, 'hex')).update('SampleifyLIMS/user-creation/key/v1').digest();
  return createHmac('sha256', commandKey).update(JSON.stringify(input), 'utf8').digest();
}
