import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.js', './src/db/template-schema.js', './src/db/master-schema.js', './src/db/workflow-schema.js', './src/db/sample-schema.js', './src/db/approval-schema.js', './src/db/report-schema.js', './src/db/report-job-schema.js', './src/db/organization-settings-schema.js', './src/db/report-assets-schema.js'],
  out: './drizzle',
  strict: true,
});
