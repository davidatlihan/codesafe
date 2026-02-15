import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './frontend/e2e',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true
  },
  webServer: [
    {
      command: 'npm run dev -w backend',
      url: 'http://127.0.0.1:4000/api/health',
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: 'npm run dev -w frontend -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000
    }
  ]
});
