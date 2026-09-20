import { createRequire } from 'node:module';

// The source control searches both labels and IDs with react-select's default
// Unicode/accent handling. Keep its Node package instance outside client inputs.
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

export function matchesModuleAccessOption(row, search) {
  const option = { value: row.id, label: row.name };
  return filter({ ...option, data: option }, search);
}
