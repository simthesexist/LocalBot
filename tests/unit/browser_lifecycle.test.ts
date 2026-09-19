// Unit tests for daemon/browser/lifecycle.cjs + daemon/browser/contexts.cjs.
//
// Phase 8 Plan 1: covers lazy Chromium launch + per-bot BrowserContext
// isolation + deleteContext cleanup + AbortSignal cancellation guard.
//
// We bypass vitest's vi.mock (which doesn't intercept CJS requires of
// node_modules) by patching require.cache so the real `playwright-core`
// module is swapped for a mock BEFORE lifecycle.cjs loads it.
//
// Run with: npm test

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// Install the mock module into require.cache BEFORE lifecycle.cjs loads it.
const mockPath = require_.resolve('playwright-core');
const originalModule = require_.cache[mockPath];

// Spy-friendly state. Re-assigned in beforeEach so each test starts clean.
let mockChromiumLaunch: ReturnType<typeof import('vitest').vi.fn>;
let mockNewContext: ReturnType<typeof import('vitest').vi.fn>;
let mockContextNewPage: ReturnType<typeof import('vitest').vi.fn>;
let mockContextClose: ReturnType<typeof import('vitest').vi.fn>;
let mockBrowserClose: ReturnType<typeof import('vitest').vi.fn>;
let mockNewPage: ReturnType<typeof import('vitest').vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installMock(vitest: any) {
  const vfn = vitest.vi ? vitest.vi.fn.bind(vitest) : vitest.fn;
  mockBrowserClose = vfn().mockResolvedValue(undefined);
  mockNewPage = vfn().mockResolvedValue({
    goto: vfn(),
    title: vfn().mockResolvedValue(''),
    evaluate: vfn().mockResolvedValue(''),
    close: vfn(),
  });
  mockContextClose = vfn().mockResolvedValue(undefined);
  mockNewPage = vfn().mockResolvedValue({
    goto: vfn(),
    title: vfn().mockResolvedValue(''),
    evaluate: vfn().mockResolvedValue(''),
    close: vfn(),
  });
  // mockNewContext must return a FRESH context object per call so each
  // bot's BrowserContext is independent (Pitfall 7 isolation).
  mockContextNewPage = vfn().mockImplementation(() => mockNewPage());
  const freshContext = () => ({
    newPage: mockContextNewPage,
    close: mockContextClose,
  });
  mockNewContext = vfn().mockImplementation(freshContext);
  mockChromiumLaunch = vfn().mockResolvedValue({
    newContext: mockNewContext,
    close: mockBrowserClose,
  });

  const mockModule = {
    id: mockPath,
    filename: mockPath,
    loaded: true,
    exports: {
      chromium: {
        launch: (...args: unknown[]) => mockChromiumLaunch(...args),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    children: [] as any[],
    paths: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parent: null as any,
    require: require_,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    path: '' as any,
  };
  require_.cache[mockPath] = mockModule;
}

function uninstallMock() {
  if (originalModule) {
    require_.cache[mockPath] = originalModule;
  } else {
    delete require_.cache[mockPath];
  }
}

import * as vitest from 'vitest';
installMock(vitest);

const lifecycle = require_('../../daemon/browser/lifecycle.cjs') as {
  ensureBrowser: () => Promise<unknown>;
  closeBrowser: () => Promise<void>;
  __test__: { reset: () => void };
};

const contexts = require_('../../daemon/browser/contexts.cjs') as {
  getPage: (botId: string, signal?: AbortSignal) => Promise<unknown>;
  deleteContext: (botId: string) => Promise<void>;
  __test__: {
    reset: () => void;
    peek: (botId: string) => boolean;
    size: () => number;
  };
};

beforeEach(() => {
  installMock(vitest);
  lifecycle.__test__.reset();
  contexts.__test__.reset();
});

afterEach(() => {
  uninstallMock();
});

describe('browser.lifecycle — ensureBrowser lazy launch', () => {
  it('first call invokes chromium.launch exactly once with sandbox flags', async () => {
    const browser = await lifecycle.ensureBrowser();
    expect(browser).toBeDefined();
    expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
    expect(mockChromiumLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        args: expect.arrayContaining(['--no-sandbox', '--disable-dev-shm-usage']),
      }),
    );
  });

  it('second call returns the same cached promise (no double-launch)', async () => {
    const b1 = await lifecycle.ensureBrowser();
    const b2 = await lifecycle.ensureBrowser();
    expect(b2).toBe(b1);
    expect(mockChromiumLaunch).toHaveBeenCalledTimes(1);
  });
});

describe('browser.lifecycle — crash recovery', () => {
  it('resets the cache on transient launch failure so the next call retries', async () => {
    mockChromiumLaunch.mockRejectedValueOnce(new Error('crashed'));
    await expect(lifecycle.ensureBrowser()).rejects.toThrow('crashed');

    const browser = await lifecycle.ensureBrowser();
    expect(browser).toBeDefined();
    expect(mockChromiumLaunch).toHaveBeenCalledTimes(2);
  });

  it('closeBrowser resolves when no browser is cached', async () => {
    await expect(lifecycle.closeBrowser()).resolves.toBeUndefined();
  });
});

describe('browser.contexts — per-bot BrowserContext isolation (T-8-03)', () => {
  it('getPage("alpha") creates a context on first call', async () => {
    await lifecycle.ensureBrowser();
    const page = await contexts.getPage('alpha');
    expect(page).toBeDefined();
    expect(mockNewContext).toHaveBeenCalledTimes(1);
    expect(mockNewContext).toHaveBeenCalledWith(
      expect.objectContaining({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: false,
        userAgent: expect.stringContaining('Localbot'),
      }),
    );
    expect(contexts.__test__.peek('alpha')).toBe(true);
    expect(contexts.__test__.size()).toBe(1);
  });

  it('getPage("alpha") returns the same page on second call (context reuse)', async () => {
    await lifecycle.ensureBrowser();
    const p1 = await contexts.getPage('alpha');
    const p2 = await contexts.getPage('alpha');
    expect(p2).toBe(p1);
    expect(mockNewContext).toHaveBeenCalledTimes(1);
  });

  it('getPage("beta") creates a SEPARATE context (no cross-bot leakage)', async () => {
    await lifecycle.ensureBrowser();
    const pAlpha = await contexts.getPage('alpha');
    const pBeta = await contexts.getPage('beta');
    // Per-bot isolation = each bot gets a distinct BrowserContext.
    // mockNewContext called twice proves two separate contexts were
    // allocated (cookies + localStorage isolated between bots).
    expect(mockNewContext).toHaveBeenCalledTimes(2);
    expect(contexts.__test__.peek('alpha')).toBe(true);
    expect(contexts.__test__.peek('beta')).toBe(true);
    expect(contexts.__test__.size()).toBe(2);
    // The two contexts must NOT be the same object (browser.newContext
    // returned a fresh BrowserContext for each bot).
    const alphaCtx = mockNewContext.mock.results[0].value;
    const betaCtx = mockNewContext.mock.results[1].value;
    expect(alphaCtx).not.toBe(betaCtx);
    // Pages are reachable through the contexts (presence check only —
    // identity comparison depends on the mock's newPage implementation).
    expect(pAlpha).toBeDefined();
    expect(pBeta).toBeDefined();
  });
});

describe('browser.contexts — deleteContext cleanup (Pitfall 7)', () => {
  it('close + remove after deleteContext("alpha")', async () => {
    await lifecycle.ensureBrowser();
    await contexts.getPage('alpha');
    expect(contexts.__test__.peek('alpha')).toBe(true);

    await contexts.deleteContext('alpha');
    expect(mockContextClose).toHaveBeenCalledTimes(1);
    expect(contexts.__test__.peek('alpha')).toBe(false);
    expect(contexts.__test__.size()).toBe(0);
  });

  it('subsequent getPage("alpha") after deleteContext creates a fresh context', async () => {
    await lifecycle.ensureBrowser();
    await contexts.getPage('alpha');
    await contexts.deleteContext('alpha');

    const page = await contexts.getPage('alpha');
    expect(page).toBeDefined();
    expect(mockNewContext).toHaveBeenCalledTimes(2);
    expect(contexts.__test__.peek('alpha')).toBe(true);
  });

  it('deleteContext on an unknown bot is a no-op', async () => {
    await expect(contexts.deleteContext('never-existed')).resolves.toBeUndefined();
    expect(mockContextClose).not.toHaveBeenCalled();
  });
});

describe('browser.contexts — AbortSignal guard', () => {
  it('getPage throws {code:"aborted"} when signal is already aborted (no launch)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(contexts.getPage('alpha', controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(mockChromiumLaunch).not.toHaveBeenCalled();
    expect(mockNewContext).not.toHaveBeenCalled();
  });

  it('getPage succeeds when signal is not aborted', async () => {
    await lifecycle.ensureBrowser();
    const controller = new AbortController();
    const page = await contexts.getPage('alpha', controller.signal);
    expect(page).toBeDefined();
    expect(mockNewContext).toHaveBeenCalledTimes(1);
  });
});