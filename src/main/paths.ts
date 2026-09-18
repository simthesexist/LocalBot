// Path helpers — all paths live under app.getPath('userData') unless
// LOCALBOT_USER_DATA_DIR is set in the environment (used by tests).

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

export function userDataDir(): string {
  // Honor the env override used by tests + smoke runs. Default to Electron's
  // canonical userData path when the env var is absent.
  return process.env.LOCALBOT_USER_DATA_DIR || app.getPath('userData');
}

export function auditDir(): string {
  return path.join(userDataDir(), 'audit');
}

export function sessionsDir(): string {
  return path.join(userDataDir(), 'sessions');
}

export function keyFilePath(): string {
  return path.join(userDataDir(), 'api-key.bin');
}

export function sessionFilePath(): string {
  return path.join(sessionsDir(), 'global.jsonl');
}

// Phase 2: bot workspace root. Lazy-created on first call so installs that
// never run tools don't pollute the user-data tree.
export function workspaceRoot(): string {
  return path.join(userDataDir(), 'workspace');
}

export async function ensureWorkspace(): Promise<string> {
  const root = workspaceRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

// Phase 2/4: per-bot metadata lives here. Phase 2 has no per-bot files yet;
// Phase 4 reads <userData>/bots/<bot>.json to load tool allowlists and
// personas.
export function botsDir(): string {
  return path.join(userDataDir(), 'bots');
}

// Phase 3 Wave 1: per-bot directory + memory file + facts file + session
// JSONL path. All live under <userData>/bots/<bot>/. The daemon's safe_path
// uses ctx.botDir to enforce containment; main uses these helpers to locate
// the same paths from its side.
export function botDir(bot: string): string {
  return path.join(botsDir(), bot);
}

export function memoryPath(bot: string): string {
  return path.join(botDir(bot), 'memory.md');
}

export function factsPath(bot: string): string {
  return path.join(botDir(bot), 'facts.json');
}

export function sessionFilePathForBot(bot: string, sessionId: string): string {
  return path.join(sessionsDir(), bot, `${sessionId}.jsonl`);
}

export async function ensureSessionDir(bot: string): Promise<string> {
  const dir = path.join(sessionsDir(), bot);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureBotDir(bot: string): Promise<string> {
  const dir = botDir(bot);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function ensureUserDataDirs(): Promise<void> {
  const dirs = [userDataDir(), auditDir(), sessionsDir(), botsDir()];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}