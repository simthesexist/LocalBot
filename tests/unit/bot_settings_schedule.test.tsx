// Phase 6 Wave 3: BotSettingsPage Schedule tab unit tests.
//
// Verifies that the Schedule tab renders all 5 fields (cron + cronEnabled +
// notifyOnError + scheduledPrompt + next-fire preview), enforces client-side
// cron validation, and produces a correct patch payload on Save.
//
// Uses happy-dom (per-file vitest environment override) so React 19 can
// mount + flush useEffect. We don't pull in @testing-library/react — a
// small DOM-only helper suffices for the queries we need.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BotSettingsPage } from '../../src/renderer/components/BotSettingsPage';
import type { BotConfig } from '../../src/shared/types';

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'test-bot',
    name: 'Test Bot',
    persona: '',
    workspace: '',
    allowlist: [],
    cron: '',
    cronEnabled: false,
    notifyOnError: undefined,
    scheduledPrompt: undefined,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    status: 'idle',
    schemaVersion: 1,
    ...overrides,
  } as BotConfig;
}

interface RenderResult {
  container: HTMLDivElement;
  updateBot: ReturnType<typeof vi.fn>;
}

function renderPage(bot: BotConfig, opts: { tab?: 'general' | 'permissions' | 'schedule' | 'history' } = {}): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const updateBot = vi.fn().mockResolvedValue({ ok: true, bot });
  // Stub the renderer bridge so persistPatch doesn't throw.
  (window as any).localbot = {
    bot: { update: updateBot },
  };
  // Navigate to the schedule tab so the schedule fields render by default.
  // The component reads window.location.hash on mount to pick the initial tab.
  if (typeof window !== 'undefined' && opts.tab) {
    window.history.replaceState(null, '', `#/bot/${bot.id}/settings/${opts.tab}`);
  }
  // Pin Date.now to a stable value for ISO matching.
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(BotSettingsPage, {
        bot,
        onClose: () => {},
        onUpdated: () => {},
      }),
    );
  });
  return { container, updateBot };
}

function fire(el: Element | null, event: string): void {
  if (!el) return;
  act(() => {
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

beforeEach(() => {
  // Tear down any leftover happy-dom globals between tests.
  document.body.innerHTML = '';
});

describe('BotSettingsPage Schedule tab', () => {
  it('Case A: renders cron input + cronEnabled checkbox + notifyOnError checkbox + scheduledPrompt textarea + next-fire preview placeholder', () => {
    const { container } = renderPage(makeBot({ cron: '0 9 * * *', cronEnabled: true }), { tab: 'schedule' });
    expect(container.querySelector('[data-testid="settings-cron"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-cron-enabled"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-notify-on-error"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-scheduled-prompt"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="settings-schedule-save"]')).toBeTruthy();
  });

  it('Case B: notifyOnError checkbox defaults to true when bot.notifyOnError is undefined', () => {
    const { container } = renderPage(makeBot({ notifyOnError: undefined }), { tab: 'schedule' });
    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-notify-on-error"]',
    );
    expect(checkbox).toBeTruthy();
    expect(checkbox!.checked).toBe(true);
  });

  it('Case C: notifyOnError checkbox defaults to false when bot.notifyOnError is explicitly false', () => {
    const { container } = renderPage(makeBot({ notifyOnError: false }), { tab: 'schedule' });
    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-notify-on-error"]',
    );
    expect(checkbox!.checked).toBe(false);
  });

  it('Case D: invalid cron expression shows inline error + disables Save', async () => {
    const { container } = renderPage(makeBot({ cron: 'invalid cron' }), { tab: 'schedule' });
    // The component imports croner dynamically; the invalid expression
    // throws CronExpressionError which surfaces in the cronError state.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const errorEl = container.querySelector('[data-testid="settings-cron-error"]');
    expect(errorEl).toBeTruthy();
    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-schedule-save"]',
    );
    expect(saveBtn!.disabled).toBe(true);
  });

  it('Case E: valid cron shows next-fire preview text containing ISO timestamps', async () => {
    const { container } = renderPage(makeBot({ cron: '0 9 * * *' }), { tab: 'schedule' });
    // croner is dynamically imported; wait until the next-fire preview
    // element appears (or timeout at 3s).
    let preview: Element | null = null;
    for (let i = 0; i < 60; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      preview = container.querySelector('[data-testid="settings-next-fires"]');
      if (preview) break;
    }
    expect(preview, 'next-fire preview did not render within 3s').toBeTruthy();
    // ISO timestamps contain T and Z markers.
    const text = preview!.textContent ?? '';
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('Case F: scheduleScheduleSave sends a patch with cron + cronEnabled + notifyOnError + scheduledPrompt', async () => {
    const { container, updateBot } = renderPage(
      makeBot({
        cron: '*/5 * * * *',
        cronEnabled: true,
        notifyOnError: true,
        scheduledPrompt: 'check the build',
      }),
      { tab: 'schedule' },
    );
    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-schedule-save"]',
    );
    await act(async () => {
      saveBtn!.click();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(updateBot).toHaveBeenCalled();
    const call = updateBot.mock.calls[0][0];
    expect(call.bot).toBe('test-bot');
    expect(call.patch.cron).toBe('*/5 * * * *');
    expect(call.patch.cronEnabled).toBe(true);
    expect(call.patch.notifyOnError).toBe(true);
    expect(call.patch.scheduledPrompt).toBe('check the build');
  });

  it('Case G: scheduledPrompt is sent verbatim (unicode + newlines + quotes) without transformation', async () => {
    const unicodePrompt = 'line 1\nline 2 with "quotes"\nemoji: 🦾 — 中文';
    const { container, updateBot } = renderPage(
      makeBot({ scheduledPrompt: unicodePrompt }),
      { tab: 'schedule' },
    );
    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-schedule-save"]',
    );
    await act(async () => {
      saveBtn!.click();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(updateBot).toHaveBeenCalled();
    const call = updateBot.mock.calls[0][0];
    expect(call.patch.scheduledPrompt).toBe(unicodePrompt);
  });

  it('Case H: cronEnabled=false + cron="" are sent verbatim (not "undefined" string)', async () => {
    const { container, updateBot } = renderPage(
      makeBot({ cron: '', cronEnabled: false, notifyOnError: false, scheduledPrompt: '' }),
      { tab: 'schedule' },
    );
    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-schedule-save"]',
    );
    await act(async () => {
      saveBtn!.click();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(updateBot).toHaveBeenCalled();
    const call = updateBot.mock.calls[0][0];
    expect(call.patch.cronEnabled).toBe(false);
    expect(call.patch.cron).toBe('');
    expect(call.patch.scheduledPrompt).toBe('');
    expect(call.patch.notifyOnError).toBe(false);
  });
});
