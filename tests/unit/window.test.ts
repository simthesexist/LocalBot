// Unit tests for src/main/window.ts — resolveRendererUrl entry-point selection.
//
// Window.ts imports `electron` at module scope (`app`, `BrowserWindow`). The
// vi.mock('electron', ...) shim satisfies those references for the duration
// of the unit test, but resolveRendererUrl never actually calls into
// `electron` — it takes a builtIndexPath parameter and checks fs.existsSync.
// That keeps the test fast and independent of any Electron runtime.
//
// Two launch modes must resolve correctly:
//   - npm run build && npm start  -> dist/renderer/index.html present
//                                  -> { kind: 'built', path }
//   - npm run dev:electron (after `rm -rf dist`)
//                                  -> dist/renderer/index.html absent
//                                  -> { kind: 'dev', url: 'http://localhost:5173' }
//   - any mode with a custom devUrl override
//                                  -> { kind: 'dev', url: <custom> }

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock is hoisted by Vitest's transformer above all imports. The factory
// must NOT reference any outer-scope variables.
vi.mock('electron', () => ({
  app: { getAppPath: () => '<unused — resolveRendererUrl takes builtIndexPath as a parameter>' },
  BrowserWindow: class {},
  // window.ts registers an `ipcMain.on(REQUEST_APP_INIT, ...)` handler at
  // module scope (see `app:init` request backstop). The unit test only
  // exercises `resolveRendererUrl`, but importing window.ts side-effects
  // through ipcMain — provide a stub so the import does not throw.
  ipcMain: { on: () => undefined },
}));

// eslint-disable-next-line import/first
import { resolveRendererUrl } from '../../src/main/window';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-window-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('resolveRendererUrl', () => {
  it('imports as a function (smoke test for the electron-mock + tsconfig setup)', () => {
    expect(typeof resolveRendererUrl).toBe('function');
  });

  it('returns { kind: "built", path } when builtIndexPath exists on disk', () => {
    const builtIndexPath = path.join(tempDir, 'index.html');
    fs.writeFileSync(builtIndexPath, '<!doctype html><title>built</title>', 'utf8');

    expect(resolveRendererUrl({ builtIndexPath })).toEqual({
      kind: 'built',
      path: builtIndexPath,
    });
  });

  it('returns { kind: "dev", url: "http://localhost:5173" } when builtIndexPath is missing', () => {
    const builtIndexPath = path.join(tempDir, 'missing', 'index.html');

    expect(resolveRendererUrl({ builtIndexPath })).toEqual({
      kind: 'dev',
      url: 'http://localhost:5173',
    });
  });

  it('honors a custom devUrl when builtIndexPath is missing', () => {
    const builtIndexPath = path.join(tempDir, 'missing', 'index.html');

    expect(resolveRendererUrl({ builtIndexPath, devUrl: 'http://localhost:9999' })).toEqual({
      kind: 'dev',
      url: 'http://localhost:9999',
    });
  });
});