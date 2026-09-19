// Phase 8 Plan 1: per-bot BrowserContext isolation.
//
// Mirrors `daemon/bots/policy.cjs#getPolicy` (module-scope Map keyed by
// botId, no caching across calls). One BrowserContext per bot; cookies +
// localStorage stay isolated between bots (Pitfall 7).
//
// Threat model coverage:
//   - T-8-03: per-bot BrowserContext isolation; deleteContext cleanup on
//     bots/delete so a removed bot's cookies can't leak to the next bot
//     that picks up the same Chrome process.
//
// The Map is module-scope (not class-scope) so the daemon process owns it
// for the lifetime of the daemon; this is intentional — the daemon
// survives multiple tool calls and the contexts must persist across
// calls (cookie / localStorage state survives navigation).
//
// signal: AbortSignal | undefined — checked at the entry point and again
// after ensureBrowser resolves. Any abort throws `{code:'aborted'}` so
// the tool dispatcher unwinds cleanly (Pitfall: cancellation).

const { ensureBrowser } = require('./lifecycle.cjs');

const contexts = new Map(); // botId → {context, page}

/**
 * getPage(botId, signal) → Promise<Page>. Lazily creates a BrowserContext
 * + Page for the bot if one doesn't exist yet. Throws `{code:'aborted'}`
 * when signal is already aborted (or aborts during).
 */
async function getPage(botId, signal) {
  if (signal && signal.aborted) {
    throw Object.assign(new Error('aborted'), { code: 'aborted' });
  }

  let entry = contexts.get(botId);
  if (!entry) {
    const browser = await ensureBrowser();
    if (signal && signal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'aborted' });
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: false,
      userAgent: 'Localbot/0.8 (+https://github.com/simthesexist/LocalBot)',
    });
    const page = await context.newPage();
    entry = { context, page };
    contexts.set(botId, entry);
  }

  if (signal && signal.aborted) {
    throw Object.assign(new Error('aborted'), { code: 'aborted' });
  }

  return entry.page;
}

/**
 * deleteContext(botId) → Promise<void>. Closes + removes the per-bot
 * BrowserContext (cookies / localStorage go with it). Best-effort — close
 * errors are swallowed so a deleteContext call never blocks bots/delete.
 */
async function deleteContext(botId) {
  const entry = contexts.get(botId);
  if (!entry) return;
  try {
    if (entry.context && typeof entry.context.close === 'function') {
      await entry.context.close();
    }
  } catch {
    /* ignore — context may already be gone */
  }
  contexts.delete(botId);
}

module.exports = {
  getPage,
  deleteContext,
  // Test seam — unit tests reset the Map between cases. peek is exposed
  // so lifecycle tests can assert map membership without exposing the
  // raw Map.
  __test__: {
    reset: () => {
      contexts.clear();
    },
    peek: (botId) => contexts.has(botId),
    size: () => contexts.size,
  },
};