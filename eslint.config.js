import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  globalIgnores(['.next/**', 'node_modules/**', '.local-migration/**', '.local/**', 'test-results/**', 'playwright-report/**', 'drizzle/meta/**']),
  { rules: { '@next/next/no-img-element': 'off' } },
]);
