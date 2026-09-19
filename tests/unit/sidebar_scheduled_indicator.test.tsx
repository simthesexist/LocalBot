// Phase 6 Wave 3: SidebarBotRow + BotSidebar scheduled indicator tests.
//
// Verifies that:
//  - bot.status === 'scheduled' renders a status dot with data-status='scheduled'
//    AND a className containing 'scheduled'.
//  - bot.status === 'running' does NOT include 'scheduled' in the dot className.
//  - BotSidebar sorts bots by status rank (scheduled > running > errored > idle),
//    then by nextFireAt ascending, then by name.
//  - 2 scheduled bots sub-sort by nextFireAt ascending (earlier fire first).
//  - The status dot's tooltip surfaces the nextFireAt when present.
//
// happy-dom per-file environment so React 19 can mount + flush.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BotSidebar } from '../../src/renderer/components/BotSidebar';
import { SidebarBotRow } from '../../src/renderer/components/SidebarBotRow';
import { __test__ as botsStoreTest } from '../../src/renderer/state/bots';
import type { BotConfig } from '../../src/shared/types';

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: overrides.id ?? 'bot',
    name: overrides.name ?? 'Bot',
    persona: '',
    workspace: '',
    allowlist: [],
    cron: '',
    cronEnabled: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    status: overrides.status ?? 'idle',
    schemaVersion: 1,
    ...overrides,
  } as BotConfig;
}

beforeEach(() => {
  // Reset the shared bots store between tests so seedBots in one test
  // doesn't leak into the next.
  botsStoreTest.reset();
  document.body.innerHTML = '';
});

describe('SidebarBotRow scheduled visual dot', () => {
  it('Case A: status="scheduled" renders a dot with data-status="scheduled" AND a className containing "scheduled"', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bot = makeBot({ id: 'a', name: 'A', status: 'scheduled' });
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(SidebarBotRow, {
          bot,
          isActive: false,
          onSelect: () => {},
          onDelete: () => {},
        }),
      );
    });
    const dot = container.querySelector('[data-testid="bot-row-a"] .bot-row-status');
    expect(dot).toBeTruthy();
    expect(dot!.getAttribute('data-status')).toBe('scheduled');
    expect(dot!.className).toContain('scheduled');
  });

  it('Case B: status="running" renders a dot with data-status="running" (NOT scheduled)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bot = makeBot({ id: 'b', name: 'B', status: 'running' });
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(SidebarBotRow, {
          bot,
          isActive: false,
          onSelect: () => {},
          onDelete: () => {},
        }),
      );
    });
    const dot = container.querySelector('[data-testid="bot-row-b"] .bot-row-status');
    expect(dot!.getAttribute('data-status')).toBe('running');
    expect(dot!.className).not.toContain('scheduled');
  });

  it('Case F: tooltip includes nextFireAt when present on a scheduled bot', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const bot = makeBot({
      id: 'c',
      name: 'C',
      status: 'scheduled',
      nextFireAt: '2030-01-01T12:00:00.000Z',
    });
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(SidebarBotRow, {
          bot,
          isActive: false,
          onSelect: () => {},
          onDelete: () => {},
        }),
      );
    });
    const dot = container.querySelector('[data-testid="bot-row-c"] .bot-row-status');
    const title = dot!.getAttribute('title');
    expect(title).toContain('Scheduled');
    expect(title).toContain('2030-01-01T12:00:00.000Z');
  });
});

describe('BotSidebar sort order', () => {
  function renderSidebar(bots: BotConfig[]): { root: ReturnType<typeof createRoot>; container: HTMLDivElement } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    // Stub the bots store so useBots returns the test bots. seedBots
    // takes initialBots into the store on first mount; we also stub
    // window.localbot.bot.list so the refresh() call doesn't clobber
    // our seeded list with an error fallback.
    (window as any).localbot = {
      bot: {
        list: () => Promise.resolve({ ok: true, bots }),
        update: () => Promise.resolve({ ok: true }),
      },
      on: () => () => {},
    };
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(BotSidebar, { initialBots: bots }),
      );
    });
    return { root, container };
  }

  function rowIds(container: HTMLDivElement): string[] {
    const rows = Array.from(
      container.querySelectorAll('[data-testid^="bot-row-"]'),
    );
    return rows.map((r) => r.getAttribute('data-bot-id') ?? '');
  }

  it('Case C: scheduled bots appear first, then by name ascending', () => {
    const bots: BotConfig[] = [
      makeBot({ id: 'idle1', name: 'Aaron', status: 'idle' }),
      makeBot({ id: 'sched1', name: 'Scheduled Bot', status: 'scheduled' }),
      makeBot({ id: 'idle2', name: 'Zara', status: 'idle' }),
    ];
    const { container } = renderSidebar(bots);
    expect(rowIds(container)).toEqual(['sched1', 'idle1', 'idle2']);
  });

  it('Case D: 2 scheduled bots sub-sort by nextFireAt ascending (earlier fire first)', () => {
    const bots: BotConfig[] = [
      makeBot({ id: 'later', name: 'Later', status: 'scheduled', nextFireAt: '2030-12-31T12:00:00.000Z' }),
      makeBot({ id: 'sooner', name: 'Sooner', status: 'scheduled', nextFireAt: '2030-01-01T09:00:00.000Z' }),
    ];
    const { container } = renderSidebar(bots);
    expect(rowIds(container)).toEqual(['sooner', 'later']);
  });

  it('Case E: mixed status sort: scheduled > running > idle', () => {
    const bots: BotConfig[] = [
      makeBot({ id: 'idle', name: 'Idle', status: 'idle' }),
      makeBot({ id: 'running', name: 'Running', status: 'running' }),
      makeBot({ id: 'sched', name: 'Scheduled', status: 'scheduled' }),
    ];
    const { container } = renderSidebar(bots);
    expect(rowIds(container)).toEqual(['sched', 'running', 'idle']);
  });
});
