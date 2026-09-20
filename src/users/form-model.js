const textFields = ['phone', 'designation'];
const references = ['businessUnitId', 'defaultRoleId', 'laboratoryId', 'reportingManagerId'];

export function userFormDraft(data) {
  const profile = data?.profile;
  return { displayName: data?.account.displayName ?? '', email: data?.account.email ?? '', username: data?.account.username ?? '', password: '',
    ...Object.fromEntries([...textFields, ...references].map(key => [key, profile?.[key] ?? ''])), canManagePeople: profile?.canManagePeople ?? false };
}

export function userFormPayload(draft, data, { id, requestId }) {
  const result = { requestId, revision: data?.account.revision ?? 0, username: draft.username.trim(), email: draft.email.trim(), displayName: draft.displayName.trim(),
    ...(data ? { profileRevision: data.profile.revision } : { id }), password: draft.password };
  const previous = userFormDraft(data); const firstProfile = !data?.profile.revision;
  for (const key of [...textFields, 'canManagePeople', ...references]) {
    if (!data && key === 'reportingManagerId') continue;
    if (firstProfile || draft[key] !== previous[key]) result[key] = key === 'canManagePeople' ? draft[key] : draft[key].trim() || null;
  }
  return result;
}

export function userFormErrors(draft, editing) {
  const errors = {};
  for (const [key, label] of [['displayName', 'Name'], ['email', 'Email'], ['username', 'Username/Employee ID'], ['defaultRoleId', 'Default Role'], ['laboratoryId', 'Lab']]) {
    if (!draft[key].trim()) errors[key] = `${label} is required.`;
  }
  if (draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = 'Enter a valid email address.';
  if ((!editing || draft.password) && (draft.password.length < 8 || draft.password.length > 200 || !draft.password.isWellFormed())) errors.password = 'Password must contain 8 to 200 valid characters.';
  return errors;
}

export function userReturnPath(value) {
  return typeof value === 'string' && /^\/user_management(?:\?[^#]*)?$/.test(value) ? value : '/user_management';
}
