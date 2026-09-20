import { createRequire } from 'node:module';
import { userFieldUserOption } from './custom-field-options.js';

// Only the server filter uses Node's package instance; rendered controls use Next's React bundle.
const nodeRequire = createRequire(
  /* webpackIgnore: true */
  /* turbopackIgnore: true */
  `${process.cwd()}/package.json`
);
const { createFilter } = nodeRequire(
  /* webpackIgnore: true */
  /* turbopackIgnore: true */
  'react-select'
);
const filter = createFilter();

export function matchesUserFieldUserOption(person, search) {
  const option = userFieldUserOption(person.id, person.name);
  return filter({ ...option, data: option }, search);
}
