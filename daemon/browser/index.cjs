// Phase 8 Plan 1 + 2: barrel re-exporting the browser sub-modules.
// Mirrors `daemon/vault/index.cjs` (Phase 7) — single import surface so
// the tools only need one require().

const policy = require('./policy.cjs');
const lifecycle = require('./lifecycle.cjs');
const contexts = require('./contexts.cjs');
// Phase 8 Plan 2: screenshot capture helper. The 5 new tools
// (browser.click + browser.type + browser.screenshot + browser.evaluate
// + browser.fill_form) all call into this module through the barrel.
const screenshots = require('./screenshots.cjs');

module.exports = {
  // Policy
  checkBrowserUrl: policy.checkBrowserUrl,
  isPrivateIp: policy.isPrivateIp,
  // Lifecycle
  ensureBrowser: lifecycle.ensureBrowser,
  closeBrowser: lifecycle.closeBrowser,
  // Per-bot contexts
  getPage: contexts.getPage,
  deleteContext: contexts.deleteContext,
  // Phase 8 Plan 2: screenshot pipeline (atomic tmp + rename + quota constants).
  captureScreenshot: screenshots.captureScreenshot,
  MAX_SCREENSHOTS_PER_RUN: screenshots.MAX_SCREENSHOTS_PER_RUN,
  MAX_TOTAL_BYTES: screenshots.MAX_TOTAL_BYTES,
  // Test seam — combined so unit tests can reset all in-memory state
  // between cases (browser_lifecycle.test.ts + browser_screenshot.test.ts).
  __test__: {
    isPrivateIp: policy.__test__.isPrivateIp,
    resetLifecycle: lifecycle.__test__.reset,
    resetContexts: contexts.__test__.reset,
    captureScreenshot: screenshots.__test__.captureScreenshot,
    MAX_SCREENSHOTS_PER_RUN: screenshots.__test__.MAX_SCREENSHOTS_PER_RUN,
    MAX_TOTAL_BYTES: screenshots.__test__.MAX_TOTAL_BYTES,
  },
};