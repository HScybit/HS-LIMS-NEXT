import { HttpError } from '../auth/errors.js';
import { hashPassword } from '../auth/passwords.js';
import { requirePermission } from '../templates/input.js';
import { userCreationInput, userCreationFingerprint } from './creation-input.js';
import { userProfileCommandError } from './profiles.js';

const errors = {
  user_creation_invalid_input: [400, 'invalid_user_creation', 'The new account is invalid.'],
  user_creation_request_reused: [409, 'save_request_reused', 'This request was already used for a different account.'],
  user_creation_identity_exists: [409, 'user_already_exists', 'This account already exists. Reload before continuing.'],
  user_creation_identifier_taken: [409, 'sign_in_identifier_taken', 'A username or email is already in use.'],
  users_username_key: [409, 'sign_in_identifier_taken', 'A username or email is already in use.'],
  users_pkey: [409, 'user_already_exists', 'This account already exists. Reload before continuing.'],
};

export async function createUser(client, identity, value) {
  requirePermission(identity, 'users.manage'); const input = userCreationInput(value);
  const fingerprint = userCreationFingerprint(input); const passwordHash = await hashPassword(input.password);
  const args = [input.id, input.requestId, fingerprint, input.username, input.email, input.displayName, passwordHash];
  for (const field of ['employeeCode', 'phone', 'designation', 'canManagePeople', 'businessUnitId']) args.push(input[field] ?? null, Object.hasOwn(input, field));
  args.push(input.defaultRoleId, input.laboratoryId, input.reportingManagerId ?? null, Object.hasOwn(input, 'reportingManagerId'), input.roleIds ?? null);
  try {
    const result = await client.query(`SELECT users_create_account(${args.map((_, index) => `$${index + 1}`).join(',')}) AS revision`, args);
    return { user: { id: input.id, username: input.username, email: input.email, displayName: input.displayName }, profileRevision: result.rows[0].revision };
  } catch (error) {
    if (errors[error.constraint]) throw new HttpError(...errors[error.constraint]);
    throw userProfileCommandError(error);
  }
}
