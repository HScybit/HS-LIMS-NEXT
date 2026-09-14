import { requirePermission } from '../templates/input.js';
import { loadUser } from './directory.js';
import { loadUserAccount, updateUserAccount } from './accounts.js';
import { loadUserProfile, updateUserProfile } from './profiles.js';
import { loadUserSignature } from './signatures.js';
import { userFormInput } from './form-input.js';

// The route owns one authenticated transaction for the complete form.
export async function updateUserForm(client, identity, userId, value) {
  requirePermission(identity, 'users.manage'); const input = userFormInput(userId, value);
  // Profile locks the actor, target and observed manager first. Password self-revocation must run last.
  const profile = input.profile ? await updateUserProfile(client, identity, input.id, input.profile) : null;
  const account = await updateUserAccount(client, identity, input.id, input.account);
  return { ...account, profileRevision: profile?.revision ?? null };
}

export async function loadUserForm(client, identity, userId) {
  const user = await loadUser(client, identity, userId);
  const account = await loadUserAccount(client, identity, user.id);
  const profile = await loadUserProfile(client, identity, user.id);
  const signature = await loadUserSignature(client, identity, user.id);
  return { user, account, profile, signature };
}
