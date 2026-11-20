import { test as base } from '@playwright/test';

// WebKit's ephemeral context rejects navigator.storage.getDirectory() before
// application code runs. Give only native OPFS tests a fresh temporary profile;
// keep the real storage, worklets and PCM assertions in all three engines.
export const storageTest = base.extend({
  context: async ({ browserName, context, playwright }, use) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }

    // The runner inherits use options and captures traces/screenshots for this
    // public API too. An empty directory requests a disposable per-test profile.
    // https://playwright.dev/docs/test-use-options#explicit-context-creation-and-option-inheritance
    const persistent = await playwright.webkit.launchPersistentContext('');
    try {
      await use(persistent);
    } finally {
      await persistent.close();
    }
  },
});
