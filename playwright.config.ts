import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'src/test/webview',
  testMatch: '*.e2e.ts',
  outputDir: 'out/playwright',
  reporter: 'list',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: { viewport: { width: 1000, height: 640 } },
});
