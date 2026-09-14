import { createFilter } from 'react-select';

const filter = createFilter();

export function userFieldUserOption(id, name) {
  return { value: id, label: String(name ?? id).replace(/[_/-]/g, ' ').replace(/\s+/g, ' ').trim() };
}

export function matchesUserFieldUserOption(person, search) {
  const option = userFieldUserOption(person.id, person.name);
  return filter({ ...option, data: option }, search);
}
