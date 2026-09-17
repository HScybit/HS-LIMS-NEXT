import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.js', './src/db/template-schema.js', './src/db/master-schema.js', './src/db/customer-history-schema.js', './src/db/master-bulk-schema.js', './src/db/material-schema.js', './src/db/nabl-schema.js', './src/db/parameter-history-schema.js', './src/db/method-history-schema.js', './src/db/product-history-schema.js', './src/db/role-history-schema.js', './src/db/user-profile-schema.js', './src/db/user-administration-schema.js', './src/db/user-custom-field-schema.js', './src/db/checklist-schema.js', './src/db/custom-field-schema.js', './src/db/custom-field-lookup-schema.js', './src/db/workflow-schema.js', './src/db/sample-schema.js', './src/db/approval-schema.js', './src/db/report-schema.js', './src/db/report-job-schema.js', './src/db/organization-settings-schema.js', './src/db/report-assets-schema.js', './src/db/sample-line-schema.js'],
  out: './drizzle',
  strict: true,
});
