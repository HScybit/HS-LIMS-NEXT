import { requirePermission } from '../templates/input.js';
import { loadUser } from './directory.js';
import { loadUserAccount, updateUserFormAccount } from './accounts.js';
import { loadUserProfile, updateUserProfile, userProfileCommandError } from './profiles.js';
import { loadUserSignature } from './signatures.js';
import { loadUserCustomFields, saveUserCustomFields } from './custom-fields.js';
import { userFormInput, userFormFingerprint } from './form-input.js';

// The route owns one authenticated transaction for the complete form.
export async function updateUserForm(client, identity, userId, value) {
  requirePermission(identity, 'users.manage'); const input = userFormInput(userId, value);
  const fingerprint = userFormFingerprint(input);
  try { await client.query('SELECT users_prepare_field_form()'); } catch (error) { throw userProfileCommandError(error); }
  // Profile locks the actor, target and observed manager first. Password self-revocation must run last.
  const profile = input.profile ? await updateUserProfile(client, identity, input.id, input.profile) : null;
  let fields = null;
  if (input.fieldCapture) {
    const { id: _id, ...values } = input.fieldCapture;
    fields = await saveUserCustomFields(client, identity, input.id, values);
  }
  const account = await updateUserFormAccount(client, identity, input.id, input.account,
    { fingerprint, profileRevision: profile?.revision ?? null, customFieldRevision: fields?.revision ?? null });
  return { ...account, profileRevision: profile?.revision ?? null, ...(fields ? { customFieldRevision: fields.revision } : {}) };
}

export async function loadUserForm(client, identity, userId) {
  const user = await loadUser(client, identity, userId);
  const account = await loadUserAccount(client, identity, user.id);
  const profile = await loadUserProfile(client, identity, user.id);
  const signature = await loadUserSignature(client, identity, user.id);
  const fieldCapture = await loadUserCustomFields(client, identity, user.id);
  return { user, account, profile, signature, fieldCapture };
}
