// Streaming chat client. Wraps @anthropic-ai/sdk pointed at M3 base URL.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { keyFilePath } from '../paths';
import { classifyError, runWithRetry } from '../errors';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';
import type { ChatMessage } from '../../shared/types';

const M3_API_BASE = process.env.M3_API_BASE || 'https://api.MiniMax.io/v1';
const M3_MODEL = process.env.M3_MODEL || 'MiniMax/M3';

async function readKey(): Promise<string> {
  const file = keyFilePath();
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

export interface StreamChatOptions {
  messages: ChatMessage[];
  system?: string;
  signal: AbortSignal;
  onToken: (delta: string) => void;
  onDone: () => void;
  onError: (e: Error) => void;
}

function toAnthropic(m: ChatMessage): { role: 'user' | 'assistant'; content: string } {
  return { role: m.role, content: m.content };
}

export async function streamChat(opts: StreamChatOptions): Promise<string> {
  const apiKey = await readKey();
  const client = new Anthropic({ apiKey, baseURL: M3_API_BASE });

  const aggregated: string[] = [];

  await runWithRetry(
    async () => {
      aggregated.length = 0;
      try {
        const stream = client.messages.stream(
          {
            model: M3_MODEL,
            system: opts.system ?? DEFAULT_SYSTEM_PROMPT,
            messages: opts.messages.map(toAnthropic),
            max_tokens: 4096,
          },
          { signal: opts.signal },
        );

        for await (const event of stream) {
          if (
            event &&
            event.type === 'content_block_delta' &&
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (event as any).delta &&
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (event as any).delta.type === 'text_delta' &&
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            typeof (event as any).delta.text === 'string'
          ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const delta: string = (event as any).delta.text;
            aggregated.push(delta);
            opts.onToken(delta);
          }
        }

        opts.onDone();
      } catch (err: any) {
        const classified = classifyError(err);
        const wrapped = new Error(classified.message) as Error & {
          category?: string;
          retryable?: boolean;
        };
        wrapped.category = classified.category;
        wrapped.retryable = classified.retryable;
        opts.onError(wrapped);
        throw err;
      }
    },
    {
      attempts: 3,
      baseDelayMs: 250,
      isRetryable: (e) => (e.category === 'transient' || e.category === 'network') && e.retryable,
    },
  );

  return aggregated.join('');
}

export const __TESTING__ = { M3_API_BASE, M3_MODEL };
