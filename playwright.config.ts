import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  timeout: 30000, use: { browserName: 'chromium', viewport: { width: 1440, height: 1050 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'pnpm run dev:react --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
    { command: 'pnpm run dev:vue --host 127.0.0.1', url: 'http://127.0.0.1:5174', reuseExistingServer: true },
  ],
});
