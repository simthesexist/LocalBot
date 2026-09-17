// Unit tests for src/main/daemon/spawn.ts — resolveDaemonEntry path resolution.
//
// Spawn.ts imports `electron` at module scope (`app`, `BrowserWindow`). The
// vi.mock('electron', ...) shim satisfies those references for the duration
// of the unit test, but resolveDaemonEntry never actually calls into
// `electron` — it takes appPath as a parameter. That keeps the test fast and
// independent of any Electron runtime.
//
// Two launch modes must resolve correctly:
//   - dev:electron  -> `electron .`           -> appPath = <project root>
//   - npm start     -> `electron dist/main/index.js`
//                                          -> appPath = <project>/dist/main
//
// After build (Task 2) the layout for the built mode is:
//   <project>/dist/main/daemon/main.cjs
// The fallback `<project>/daemon/main.cjs` covers the dev mode layout.
// When both layouts are present, the direct-child (built-mode) candidate wins.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock is hoisted by Vitest's transformer above all imports. The factory
// must NOT reference any outer-scope variables.
vi.mock('electron', () => ({
  app: { getAppPath: () => '<unused — resolveDaemonEntry takes appPath as a parameter>' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// eslint-disable-next-line import/first
import { resolveDaemonEntry } from '../../src/main/daemon/spawn';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-spawn-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('resolveDaemonEntry', () => {
  it('imports as a function (smoke test for the electron-mock + tsconfig setup)', () => {
    expect(typeof resolveDaemonEntry).toBe('function');
  });

  it('returns <appPath>/daemon/main.cjs for dev mode (electron . — appPath = project root)', () => {
    const appPath = path.join(tempDir, 'project');
    const daemonDir = path.join(appPath, 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'main.cjs'), '// stub', 'utf8');

    expect(resolveDaemonEntry(appPath)).toBe(path.join(appPath, 'daemon', 'main.cjs'));
  });

  it('returns <appPath>/daemon/main.cjs for built mode (electron dist/main/index.js — appPath = dist/main)', () => {
    const appPath = path.join(tempDir, 'project', 'dist', 'main');
    const daemonDir = path.join(appPath, 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'main.cjs'), '// stub', 'utf8');

    expect(resolveDaemonEntry(appPath)).toBe(path.join(appPath, 'daemon', 'main.cjs'));
  });

  it('falls back to the first candidate when neither layout exists on disk (no throw)', () => {
    const appPath = path.join(tempDir, 'nothing');
    const expected = path.join(appPath, 'daemon', 'main.cjs');
    expect(resolveDaemonEntry(appPath)).toBe(expected);
  });

  it('prefers the direct-child candidate when both <appPath>/daemon and <appPath>/../daemon exist', () => {
    // appPath = <tempDir>/project  -> direct child = <tempDir>/project/daemon/main.cjs
    // parent fallback            = <tempDir>/daemon/main.cjs (via ../)
    const appPath = path.join(tempDir, 'project');
    const directDir = path.join(appPath, 'daemon');
    const parentDir = path.join(tempDir, 'daemon');
    fs.mkdirSync(directDir, { recursive: true });
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(path.join(directDir, 'main.cjs'), '// direct', 'utf8');
    fs.writeFileSync(path.join(parentDir, 'main.cjs'), '// parent', 'utf8');

    expect(resolveDaemonEntry(appPath)).toBe(path.join(appPath, 'daemon', 'main.cjs'));
  });
});
