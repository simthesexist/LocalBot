// Unit tests for src/main/bots/memory.ts — mergeFacts dedup logic.
// Run with: npm test

import { describe, it, expect } from 'vitest';
import { mergeFacts } from '../../src/main/bots/memory';

type Facts = Record<string, { value: unknown; source: 'user' | 'tool' | 'summary'; updatedAt: string }>;

describe('mergeFacts', () => {
  it('keeps existing facts when incoming is empty', () => {
    const existing: Facts = {
      name: { value: 'alice', source: 'user', updatedAt: '2026-09-18T10:00:00Z' },
    };
    const merged = mergeFacts(existing, {});
    expect(merged).toEqual(existing);
  });

  it('adds new facts that do not exist yet', () => {
    const merged = mergeFacts(
      {},
      { hobby: { value: 'reading', source: 'tool', updatedAt: '2026-09-18T10:00:00Z' } },
    );
    expect(merged.hobby.value).toBe('reading');
  });

  it('overwrites existing fact when incoming has a newer updatedAt', () => {
    const existing: Facts = {
      name: { value: 'alice', source: 'user', updatedAt: '2026-09-18T10:00:00Z' },
    };
    const merged = mergeFacts(existing, {
      name: { value: 'alice-bob', source: 'tool', updatedAt: '2026-09-18T11:00:00Z' },
    });
    expect(merged.name.value).toBe('alice-bob');
    expect(merged.name.source).toBe('tool');
  });

  it('keeps existing fact when incoming has an older updatedAt', () => {
    const existing: Facts = {
      name: { value: 'alice', source: 'user', updatedAt: '2026-09-18T11:00:00Z' },
    };
    const merged = mergeFacts(existing, {
      name: { value: 'alice-bob', source: 'tool', updatedAt: '2026-09-18T10:00:00Z' },
    });
    expect(merged.name.value).toBe('alice');
  });

  it('preserves source field for new and updated facts', () => {
    const merged = mergeFacts(
      {},
      { color: { value: 'red', source: 'summary', updatedAt: '2026-09-18T10:00:00Z' } },
    );
    expect(merged.color.source).toBe('summary');
  });

  it('is pure: does not mutate inputs', () => {
    const existing: Facts = {
      a: { value: 1, source: 'user', updatedAt: '2026-09-18T10:00:00Z' },
    };
    const incoming: Facts = {
      a: { value: 2, source: 'tool', updatedAt: '2026-09-18T11:00:00Z' },
      b: { value: 3, source: 'user', updatedAt: '2026-09-18T11:00:00Z' },
    };
    const originalExisting = JSON.parse(JSON.stringify(existing));
    const originalIncoming = JSON.parse(JSON.stringify(incoming));
    mergeFacts(existing, incoming);
    expect(existing).toEqual(originalExisting);
    expect(incoming).toEqual(originalIncoming);
  });

  it('rejects incoming entries without a value field', () => {
    expect(() =>
      mergeFacts({}, { bad: { source: 'user', updatedAt: '2026-09-18T10:00:00Z' } as unknown as Facts[string] }),
    ).toThrow(/invalid_facts_schema/);
  });

  it('preserves source="tool" over "user" when updatedAt is newer', () => {
    const existing: Facts = {
      name: { value: 1, source: 'user', updatedAt: '2026-01-01T00:00:00Z' },
    };
    const merged = mergeFacts(existing, {
      name: { value: 2, source: 'tool', updatedAt: '2026-09-01T00:00:00Z' },
    });
    expect(merged.name.value).toBe(2);
    expect(merged.name.source).toBe('tool');
    expect(merged.name.updatedAt).toBe('2026-09-01T00:00:00Z');
  });
});