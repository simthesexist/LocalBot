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

export async function ensureUserDataDirs(): Promise<void> {
  const dirs = [userDataDir(), auditDir(), sessionsDir()];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}
