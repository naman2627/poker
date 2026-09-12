import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './servers';

/**
 * One table, one worker.
 *
 * These tests share a real server with a seeded deck, so running two of them at
 * once would deal both from the same shuffle and interleave their tables. The
 * point of the suite is a hand played exactly, not throughput.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './.artifacts/test-results',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
