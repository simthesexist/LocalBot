// Summarizer. Phase 3 tracer slice.
//
// Calls M3 with a SEPARATE retry budget and a CHILD AbortSignal so user
// cancel aborts the summary call only — the outer loop's AbortSignal is
// untouched (Pitfall 4 + Research Decision D-17/D-18). The result is a
// single summary string + an optional facts delta that the caller merges
// into facts.json via the daemon's memory.write.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { runWithRetry } from '../errors';
import type { ChatMessage } from '../../shared/types';
import type { Facts } from '../bots/memory';

const M3_API_BASE = process.env.M3_API_BASE || 'https://api.MiniMax.io/v1';
const M3_MODEL = process.env.M3_MODEL || 'MiniMax/M3';

async function readKey(): Promise<string> {
  const file = process.env.LOCALBOT_KEY_FILE || (await import('../paths')).keyFilePath();
  const buf = await fs.promises.readFile(file);
  const cipherB64 = buf.toString('utf8');
  const cipher = Buffer.from(cipherB64, 'base64');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refusing to read key in plaintext');
  }
  return safeStorage.decryptString(cipher);
}

export interface SummarizeResult {
  summary: string;
  factsDelta: Facts;
}

const SUMMARIZER_SYSTEM =
  'You are a concise summarizer. Output JSON only: ' +
  '{"summary":"<<=300 words>", "facts":{"<name>":{"value":<value>,"source":"summary","updatedAt":"<iso>"}}}. ' +
  'If you cannot produce JSON, output plain text starting with "Summary:".';

/**
 * Run the summarizer. Uses its OWN runWithRetry instance (separate budget
 * from the outer streamChat), and a child AbortSignal so user cancel
 * aborts just this call.
 */
export async function runSummarizer(
  turns: ChatMessage[],
  signal: AbortSignal,
): Promise<SummarizeResult> {
  const apiKey = await readKey();
  const client = new Anthropic({ apiKey, baseURL: M3_API_BASE });

  // Child signal: combines the caller's signal with a fresh controller so we
  // can independently abort this call. Production code never sees the inner
  // controller; the outer signal is the only handle callers carry.
  const childController = new AbortController();
  const onParentAbort = () => childController.abort();
  if (signal.aborted) childController.abort();
  else signal.addEventListener('abort', onParentAbort, { once: true });

  try {
    const userContent = turns
      .map((t) => {
        const c = t.content as unknown;
        let text = '';
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          text = (c as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
        }
        return `${t.role}: ${text}`;
      })
      .join('\n');

    const response = await runWithRetry(
      async () => client.messages.create({
        model: M3_MODEL,
        max_tokens: 1024,
        system: SUMMARIZER_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      }, { signal: childController.signal }) as Promise<Anthropic.Messages.Message>,
      {
        attempts: 3,
        baseDelayMs: 250,
        // Summarizer retries are limited to transient / network failures —
        // auth errors and fatal errors bubble up immediately so the outer
        // loop can decide whether to fall back.
        isRetryable: (e) => e.category === 'transient' || e.category === 'network',
      },
    );

    const text = response.content?.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
    const raw = text?.text ?? '';
    return parseSummarizerResponse(raw);
  } finally {
    signal.removeEventListener('abort', onParentAbort);
  }
}

function parseSummarizerResponse(raw: string): SummarizeResult {
  if (!raw) return { summary: '', factsDelta: {} };
  // Try JSON first.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.summary === 'string') {
      const facts = (parsed.facts && typeof parsed.facts === 'object' && !Array.isArray(parsed.facts))
        ? (parsed.facts as Facts)
        : {};
      return { summary: parsed.summary, factsDelta: facts };
    }
  } catch {
    // fall through to plain-text branch
  }
  if (raw.startsWith('Summary:')) {
    return { summary: raw.slice('Summary:'.length).trim(), factsDelta: {} };
  }
  return { summary: raw, factsDelta: {} };
}

/** Test hook — exported only so unit tests can exercise the parser. */
export const __TESTING__ = { parseSummarizerResponse };