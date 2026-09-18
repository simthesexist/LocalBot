// Unit tests for src/main/llm/summarize.ts.
//
// The summarizer has a pure parser branch that handles three response shapes:
//   1. JSON {summary, facts}
//   2. Plain text starting with "Summary:"
//   3. Empty body
// The runSummarizer() function routes raw text through that parser, so we
// can avoid spinning up the M3 client entirely by exercising the parser
// via the module's __TESTING__ export.

import { describe, it, expect } from 'vitest';
import { __TESTING__ } from '../../src/main/llm/summarize';

const { parseSummarizerResponse } = __TESTING__;

describe('summarize.parseSummarizerResponse', () => {
  it('parses JSON with summary + facts into the structured result', () => {
    const out = parseSummarizerResponse(
      JSON.stringify({
        summary: 'Three-bullet recap',
        facts: {
          project: { value: 'localbot', source: 'summary', updatedAt: '2025-01-01T00:00:00Z' },
        },
      }),
    );
    expect(out.summary).toBe('Three-bullet recap');
    expect(out.factsDelta.project).toBeDefined();
    expect(out.factsDelta.project.value).toBe('localbot');
    expect(out.factsDelta.project.source).toBe('summary');
  });

  it('parses JSON without facts by defaulting factsDelta to {}', () => {
    const out = parseSummarizerResponse(JSON.stringify({ summary: 'No facts here' }));
    expect(out.summary).toBe('No facts here');
    expect(out.factsDelta).toEqual({});
  });

  it('falls back to plain text when the body begins with "Summary:"', () => {
    const out = parseSummarizerResponse('Summary: a friendly recap with no JSON');
    expect(out.summary).toBe('a friendly recap with no JSON');
    expect(out.factsDelta).toEqual({});
  });

  it('returns empty summary when the body is empty', () => {
    const out = parseSummarizerResponse('');
    expect(out.summary).toBe('');
    expect(out.factsDelta).toEqual({});
  });

  it('returns the raw text as the summary when no JSON / no prefix', () => {
    const out = parseSummarizerResponse('just a plain string');
    expect(out.summary).toBe('just a plain string');
  });

  it('ignores `facts` that are not a plain object (arrays)', () => {
    const out = parseSummarizerResponse(JSON.stringify({
      summary: 'with-array-facts',
      facts: ['not-a-record'],
    }));
    expect(out.summary).toBe('with-array-facts');
    expect(out.factsDelta).toEqual({});
  });
});
