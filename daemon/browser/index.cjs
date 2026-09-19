// Phase 8 Plan 1: barrel re-exporting the three browser sub-modules.
// Mirrors `daemon/vault/index.cjs` (Phase 7) — single import surface so
// the tools only need one require().

const policy = require('./policy.cjs');
const lifecycle = require('./lifecycle.cjs');
const contexts = require('./contexts.cjs');

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
  // Test seam — combined so unit tests can reset all in-memory state
  // between cases (browser_lifecycle.test.ts).
  __test__: {
    isPrivateIp: policy.__test__.isPrivateIp,
    resetLifecycle: lifecycle.__test__.reset,
    resetContexts: contexts.__test__.reset,
  },
};