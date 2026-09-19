// Unit tests for the main-process notification bridge — Phase 6 Wave 2
// (AGENT-10 toast construction). Exercises `handleScheduledError` and the
// `registerNotificationHandlers` wiring without depending on Electron's
// runtime or actually popping a Windows toast.
//
// Threat model coverage:
//   T-P6-10 debounce: case C (same-bot 60s) + case D (different bots)
//   T-P6-11 body slice: case B
//   T-P6-15 headless: case E
//   T-P6-09 spoofing: case A (only handleScheduledError constructs the
//     toast; renderer cannot synthesize one)
//
// Test pattern mirrors tests/unit/exec_approve.test.ts: vi.mock('electron')
// intercepts the Notification + BrowserWindow constructors; fs.mkdtempSync
// creates a temp userDataDir per test. We use vi.hoisted to share the
// ctor-args collector across the mock factory and the test assertions.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctorTracker = vi.hoisted(() => ({
  ctorArgs: [] as Array<{ title: string; body: string; silent: boolean }>,
  clickHandlers: [] as Array<(event?: unknown) => void>,
  instances: [] as Array<{ show: ReturnType<typeof vi.fn>; on: (e: string, h: (...a: unknown[]) => void) => void }>,
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported = vi.fn(() => true);
    public show = vi.fn();
    public on(event: string, handler: (...args: unknown[]) => void): void {
      if (event === 'click') ctorTracker.clickHandlers.push(handler as (e?: unknown) => void);
    }
    public constructor(public options: { title: string; body: string; silent: boolean }) {
      ctorTracker.ctorArgs.push(options);
      ctorTracker.instances.push(this);
    }
  },
  BrowserWindow: class {
    public static getAllWindows = vi.fn(() => []);
    public webContents = { send: vi.fn() };
    public isDestroyed = vi.fn(() => false);
    public isMinimized = vi.fn(() => false);
    public restore = vi.fn();
    public show = vi.fn();
    public focus = vi.fn();
  },
  app: {
    setAppUserModelId: vi.fn(),
    getPath: vi.fn(() => os.tmpdir()),
  },
}));

import * as electronMock from 'electron';
import {
  handleScheduledError,
  registerNotificationHandlers,
  __test__,
} from '../../src/main/ipc/notifications';
import type { ScheduledErrorEvent } from '../../src/shared/types';

let userDataDir = '';
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localbot-scheduler-notif-'));
  process.env.LOCALBOT_USER_DATA_DIR = userDataDir;
  ctorTracker.ctorArgs.length = 0;
  ctorTracker.clickHandlers.length = 0;
  ctorTracker.instances.length = 0;
  __test__._resetForTest();
  vi.mocked(electronMock.Notification.isSupported).mockReturnValue(true);
  vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([] as unknown as ReturnType<typeof electronMock.BrowserWindow.getAllWindows>);
  vi.mocked(electronMock.app.setAppUserModelId).mockClear();
});
afterEach(() => {
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.LOCALBOT_USER_DATA_DIR;
});

function writeBotConfig(bot: string, cfg: Record<string, unknown>): void {
  const dir = path.join(userDataDir, 'bots', bot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

function basePayload(bot = 'alpha'): ScheduledErrorEvent {
  return {
    bot,
    runId: 'r-1',
    errorMessage: 'boom',
    ts: new Date().toISOString(),
  };
}

describe('handleScheduledError — toast construction', () => {
  it('constructs a Notification with title="Bot errored: <name>" + body=errorMessage when config.json resolves', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    handleScheduledError(basePayload('alpha'));

    expect(ctorTracker.ctorArgs).toHaveLength(1);
    expect(ctorTracker.ctorArgs[0].title).toBe('Bot errored: Alpha');
    expect(ctorTracker.ctorArgs[0].body).toBe('boom');
    expect(ctorTracker.ctorArgs[0].silent).toBe(false);
  });

  it('slices errorMessage to 120 chars when the message is longer', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    const longMsg = 'x'.repeat(200);
    handleScheduledError({ ...basePayload('alpha'), errorMessage: longMsg });

    expect(ctorTracker.ctorArgs).toHaveLength(1);
    expect(ctorTracker.ctorArgs[0].body.length).toBe(__test__.TOAST_BODY_MAX_CHARS);
    expect(ctorTracker.ctorArgs[0].body).toBe('x'.repeat(120));
  });

  it('debounces 2 calls for the SAME bot within 60s — second call does NOT construct a Notification', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    handleScheduledError(basePayload('alpha'));
    handleScheduledError(basePayload('alpha')); // debounced
    expect(ctorTracker.ctorArgs).toHaveLength(1);

    // After reset + a fresh call, the next call goes through.
    __test__._resetForTest();
    handleScheduledError(basePayload('alpha'));
    expect(ctorTracker.ctorArgs).toHaveLength(2);
  });

  it('does NOT debounce across DIFFERENT bots — both notifications fire', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    writeBotConfig('beta', { id: 'beta', name: 'Beta', schemaVersion: 1, allowlist: [] });
    handleScheduledError(basePayload('alpha'));
    handleScheduledError(basePayload('beta'));
    expect(ctorTracker.ctorArgs).toHaveLength(2);
    const titles = ctorTracker.ctorArgs.map((a) => a.title);
    expect(titles).toContain('Bot errored: Alpha');
    expect(titles).toContain('Bot errored: Beta');
  });

  it('does NOT throw + logs a console.warn when Notification.isSupported() === false', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    vi.mocked(electronMock.Notification.isSupported).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => handleScheduledError(basePayload('alpha'))).not.toThrow();
    expect(ctorTracker.ctorArgs).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back to payload.bot as the title when config.json is malformed JSON', () => {
    const dir = path.join(userDataDir, 'bots', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json {{{', 'utf8');
    expect(() => handleScheduledError(basePayload('alpha'))).not.toThrow();
    expect(ctorTracker.ctorArgs).toHaveLength(1);
    expect(ctorTracker.ctorArgs[0].title).toBe('Bot errored: alpha');
  });

  it('falls back to payload.bot as the title when the bot directory does not exist', () => {
    // No bots/alpha dir written at all.
    expect(() => handleScheduledError(basePayload('alpha'))).not.toThrow();
    expect(ctorTracker.ctorArgs).toHaveLength(1);
    expect(ctorTracker.ctorArgs[0].title).toBe('Bot errored: alpha');
  });

  it('handles empty errorMessage without throwing (body is the empty string)', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    expect(() => handleScheduledError({ ...basePayload('alpha'), errorMessage: '' })).not.toThrow();
    expect(ctorTracker.ctorArgs).toHaveLength(1);
    expect(ctorTracker.ctorArgs[0].title).toBe('Bot errored: Alpha');
    expect(ctorTracker.ctorArgs[0].body).toBe('');
  });

  it('calls app.setAppUserModelId exactly once across multiple invocations (Pitfall 6 mitigation)', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    writeBotConfig('beta', { id: 'beta', name: 'Beta', schemaVersion: 1, allowlist: [] });
    __test__._resetForTest();
    vi.mocked(electronMock.app.setAppUserModelId).mockClear();

    handleScheduledError(basePayload('alpha'));
    handleScheduledError(basePayload('beta'));

    expect(electronMock.app.setAppUserModelId).toHaveBeenCalledTimes(1);
    expect(electronMock.app.setAppUserModelId).toHaveBeenCalledWith(__test__.DEFAULT_APP_USER_MODEL_ID);
  });
});

describe('registerNotificationHandlers — daemon notification bridge', () => {
  it('is idempotent — calling twice does not throw + sets appUserModelId exactly once', () => {
    writeBotConfig('alpha', { id: 'alpha', name: 'Alpha', schemaVersion: 1, allowlist: [] });
    __test__._resetForTest();
    vi.mocked(electronMock.app.setAppUserModelId).mockClear();

    expect(() => {
      registerNotificationHandlers();
      registerNotificationHandlers();
    }).not.toThrow();

    // setAppUserModelId guard: still exactly one invocation across both calls.
    expect(electronMock.app.setAppUserModelId).toHaveBeenCalledTimes(1);
  });
});
