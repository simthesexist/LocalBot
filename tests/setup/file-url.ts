// Helpers shared by Playwright smoke tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function fileURLForCwd(): string {
  return pathToFileURL(process.cwd()).href;
}

export function tempUserData(prefix = 'localbot-pw-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'Localbot');
}
