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

// Phase 5 Wave 2: per-bot always-allow list lives at
// <userData>/bots/<bot>/alwaysAllow.json — populated atomically by the daemon
// when the user clicks "always" on a shell approval prompt. Main mirrors the
// file when an "allow-always" decision comes from the renderer so the IPC
// handler never has to race the daemon's own write.
export function alwaysAllowPath(bot: string): string {
  return path.join(botDir(bot), 'alwaysAllow.json');
}

// Phase 7 Plan 1: global Obsidian vault config lives at
// <userData>/vault.json. The daemon owns the file (atomic tmp+rename +
// persistQueue serialization). Main uses this helper to compose the same
// path when wiring the IPC bridge so renderer + daemon agree.
export function vaultConfigPath(): string {
  return path.join(userDataDir(), 'vault.json');
}

// Phase 8 Plan 1: per-runId screenshot directory. The daemon writes
// PNG files into `<userData>/screenshots/<runId>/<n>.png`; main reads
// them back through the `app://` protocol handler (Plan 2). Layout
// mirrors `<userData>/sessions/<bot>/<sessionId>.jsonl` (Phase 3).
export function screenshotDir(): string {
  return path.join(userDataDir(), 'screenshots');
}

export async function ensureScreenshotDir(): Promise<string> {
  const dir = screenshotDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function screenshotPath(runId: string, n: string): string {
  return path.join(screenshotDir(), runId, `${n}.png`);
}