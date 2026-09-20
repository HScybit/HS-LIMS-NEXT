import { defineConfig, devices } from '@playwright/test';

process.loadEnvFile('.env.local');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    command: 'npm run start -- --port 3100',
    url: 'http://127.0.0.1:3100/login',
    reuseExistingServer: false,
    env: { APP_ORIGIN: 'http://127.0.0.1:3100', NEXT_TELEMETRY_DISABLED: '1' },
    timeout: 60_000,
  },
});
