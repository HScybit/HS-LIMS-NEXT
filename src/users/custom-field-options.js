export function userFieldUserOption(id, name) {
  return { value: id, label: String(name ?? id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() };
}
