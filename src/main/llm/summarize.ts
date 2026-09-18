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

/** Error shape surfaced to the caller when the summary is cancelled mid-flight. */
export class SummarizeAbortError extends Error {
  readonly category = 'cancel';
  readonly code = 'aborted';
  constructor(message: string = 'summarizer aborted') {
    super(message);
  }
}

export interface RunSummarizerOptions {
  /**
   * Outer cancel signal — the user's per-msgId controller. When this fires
   * we abort the SUMMARY call only via the inner childController. We NEVER
   * abort the outer streamChat retry from this path.
   */
  outerSignal: AbortSignal;
  /**
   * Optional pre-derived child signal. When provided, the caller owns the
   * controller and can decide whether to abort just the summary while
   * keeping the outer signal untouched (RESEARCH.md §"Pitfall 4").
   */
  childSignal?: AbortSignal;
}

const SUMMARIZER_SYSTEM =
  'You are a concise summarizer. Output JSON only: ' +
  '{"summary":"<<=300 words>", "facts":{"<name>":{"value":<value>,"source":"summary","updatedAt":"<iso>"}}}. ' +
  'If you cannot produce JSON, output plain text starting with "Summary:".';

/**
 * Run the summarizer. Uses its OWN runWithRetry instance (separate budget
 * from the outer streamChat), and a child AbortSignal so user cancel
 * aborts just this call.
 *
 * Accepts either the legacy `(turns, signal)` signature OR the new
 * `(turns, { outerSignal, childSignal? })` shape. The legacy form derives
 * a child signal internally so existing callers continue to compile.
 */
export async function runSummarizer(
  turns: ChatMessage[],
  signalOrOpts: AbortSignal | RunSummarizerOptions,
): Promise<SummarizeResult> {
  const opts: RunSummarizerOptions =
    typeof signalOrOpts === 'object' && signalOrOpts && 'outerSignal' in signalOrOpts
      ? signalOrOpts
      : { outerSignal: signalOrOpts as AbortSignal };

  const outerSignal = opts.outerSignal;
  if (outerSignal && outerSignal.aborted) {
    throw new SummarizeAbortError('outer signal already aborted before summarizer started');
  }

  const apiKey = await readKey();
  const client = new Anthropic({ apiKey, baseURL: M3_API_BASE });

  // Child signal — either supplied by the caller (preferred) or derived
  // here from a fresh controller so the inner SDK call can be aborted
  // independently. Production callers (chat.ts) own a per-call controller
  // so it can reset between turns.
  const ownsChild = !opts.childSignal;
  const childController = ownsChild ? new AbortController() : null;
  const childSignal: AbortSignal = opts.childSignal ?? childController!.signal;

  const onParentAbort = () => {
    if (childController) childController.abort();
  };
  outerSignal.addEventListener('abort', onParentAbort, { once: true });

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
      }, { signal: childSignal }) as Promise<Anthropic.Messages.Message>,
      {
        attempts: 3,
        baseDelayMs: 250,
        // Summarizer retries are limited to transient / network failures —
        // auth errors and fatal errors bubble up immediately so the outer
        // loop can decide whether to fall back. When the child has been
        // aborted (user cancelled mid-summary) we stop retrying.
        isRetryable: (e) =>
          (e.category === 'transient' || e.category === 'network') &&
          !childSignal.aborted,
      },
    );

    if (childSignal.aborted) {
      throw new SummarizeAbortError('child signal aborted after response');
    }

    const text = response.content?.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
    const raw = text?.text ?? '';
    return parseSummarizerResponse(raw);
  } catch (err) {
    if (childSignal.aborted && !(err instanceof SummarizeAbortError)) {
      throw new SummarizeAbortError((err as Error)?.message ?? 'aborted');
    }
    throw err;
  } finally {
    outerSignal.removeEventListener('abort', onParentAbort);
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
export const __TESTING__ = { parseSummarizerResponse, SummarizeAbortError };