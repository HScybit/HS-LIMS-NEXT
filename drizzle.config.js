import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.js', './src/db/template-schema.js', './src/db/master-schema.js', './src/db/workflow-schema.js', './src/db/sample-schema.js'],
  out: './drizzle',
  strict: true,
});
