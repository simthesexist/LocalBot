// Append/read for the global session JSONL file (global.jsonl under <userData>/sessions/).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { sessionFilePath } from '../paths';
import type { ChatMessage } from '../../shared/types';

const SESSION_FILENAME = 'global.jsonl';

export interface AppendInput {
  role: 'user' | 'assistant';
  content: string;
  stopped?: boolean;
  interrupted?: boolean;
  msgId?: string;
}

export async function appendMessage(input: AppendInput): Promise<void> {
  const record: ChatMessage = {
    ts: Date.now(),
    role: input.role,
    content: input.content,
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
      out.push(JSON.parse(trimmed) as ChatMessage);
    } catch {
      // skip malformed
    }
  }
  return out;
}
