import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/models',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results/models',
  reporter: [['list'], ['json', { outputFile: 'test-results/models-playwright.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.MODEL_TEST_SKIP_BUILD === '1'
      ? 'npm run preview -- --port 4173 --strictPort'
      : 'npm run build:test && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
