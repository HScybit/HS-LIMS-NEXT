import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testDir: './tests/performance',
  timeout: 900_000,
  reporter: [['list']],
});
