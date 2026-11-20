import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4182';
const chromiumOptions = {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ['--disable-dev-shm-usage'],
};
// Every desktop spec runs in all three engines unless its filename explicitly
// marks an engine-specific fixture. New shared specs must not need an allowlist.
const desktopTestIgnore = ['**/mobile.spec.js', '**/*.chromium.spec.js'];

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  outputDir: 'test-results/browser',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1, // Each codec worker owns a sizable WASM heap.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/browser-results.json' }],
  ],
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: '**/mobile.spec.js', use: { browserName: 'chromium', launchOptions: chromiumOptions } },
    { name: 'firefox', testIgnore: desktopTestIgnore, use: { browserName: 'firefox' } },
    { name: 'webkit', testIgnore: desktopTestIgnore, use: { browserName: 'webkit' } },
    { name: 'mobile-chromium', testMatch: '**/mobile.spec.js', use: { ...devices['Pixel 7'], browserName: 'chromium', launchOptions: chromiumOptions } },
    { name: 'mobile-webkit', testMatch: '**/mobile.spec.js', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run preview -- --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
