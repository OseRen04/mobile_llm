import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/extension',
  outputDir: './test-results/extension-browser',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
});
