// Append/read for the global session JSONL file (global.jsonl under <userData>/sessions/).
//
// Phase 2: appendMessage accepts optional `blocks?: MessageBlock[]` and writes
// them into the JSONL row. Legacy loaders fall back to the `content` field.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sessionFilePath } from '../paths';
import type { ChatMessage, MessageBlock } from '../../shared/types';

const SESSION_FILENAME = 'global.jsonl';

export interface AppendInput {
  role: 'user' | 'assistant';
  content: string;
  blocks?: MessageBlock[];
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
}

export async function appendMessage(input: AppendInput): Promise<void> {
  const record: ChatMessage = {
    ts: Date.now(),
    role: input.role,
    content: input.content,
    blocks: input.blocks,
    stopped: input.stopped,
    interrupted: input.interrupted,
    msgId: input.msgId,
  };
  await fs.appendFile(sessionFilePath(), JSON.stringify(record) + '\n', 'utf8');
}

export async function loadSession(): Promise<ChatMessage[]> {
  const file = sessionFilePath();
  if (!existsSync(file)) return [];
  const text = await fs.readFile(file, 'utf8');
  const out: ChatMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ChatMessage;
      // Phase 2: preserve optional blocks array as-is. No shape migration
      // needed for legacy rows that only carry `content`.
      out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}
