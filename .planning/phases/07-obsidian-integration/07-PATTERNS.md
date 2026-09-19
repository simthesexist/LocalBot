# Phase 7: Obsidian Integration - Pattern Map

**Mapped:** 2026-09-19
**Files analyzed:** 28 (new + extended)
**Analogs found:** 24 / 28 (exact or role-match) ; 4 no-analog

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `daemon/tools/vault_read.cjs` (NEW) | tool | file-I/O + glob check | `daemon/tools/read_file.cjs` | role-match (read + safe_path) |
| `daemon/tools/vault_write.cjs` (NEW) | tool | file-I/O + containment | `daemon/tools/write_file.cjs` | role-match (write + atomic) |
| `daemon/tools/vault_search.cjs` (NEW) | tool | file-I/O + ripgrep + glob filter | `daemon/tools/code_search.cjs` | exact (rg --json + readline + max_results) |
| `daemon/tools/vault_list.cjs` (NEW) | tool | file-I/O (list) | `daemon/tools/list_dir.cjs` | exact (readdir + sort) |
| `daemon/vault/config.cjs` (NEW) | module | config persistence (atomic JSON) | `daemon/scheduler/index.cjs` (readSchedulesFile + persistSchedules) | exact (atomic JSON + tmp+rename) |
| `daemon/vault/glob.cjs` (NEW) | utility | glob matching (picomatch) | none — picomatch is new | no-analog |
| `daemon/vault/wikilink.cjs` (NEW) | utility | regex parsing + index lookup | none — wikilink is new | no-analog |
| `daemon/vault/index.cjs` (NEW) | module | barrel exports | none — barrel | no-analog |
| `daemon/main.cjs` (extended) | daemon entry | JSON-RPC dispatch + audit | `daemon/main.cjs` (existing) | self (extend) |
| `daemon/bots/loader.cjs` (extended) | module | config validation + atomic write | `daemon/bots/loader.cjs` (existing ALLOWED_CONFIG_KEYS) | self (extend) |
| `src/main/ipc/vault.ts` (NEW) | IPC bridge | request-response (daemon JSON-RPC) | `src/main/ipc/bots.ts` (registerBotHandlers) | exact |
| `src/main/preload/index.ts` (extended) | preload | contextBridge surface | `src/main/preload/index.ts` (existing) | self (extend) |
| `src/main/paths.ts` (extended) | path helper | sync helper | `src/main/paths.ts` (existing workspaceRoot/botDir) | self (extend) |
| `src/shared/ipc-channels.ts` (extended) | shared constants | channel names | `src/shared/ipc-channels.ts` (existing CHANNELS) | self (extend) |
| `src/shared/types.ts` (extended) | shared types | type definitions | `src/shared/types.ts` (existing BotConfig + MessageBlock) | self (extend) |
| `src/renderer/components/BotSettingsPage.tsx` (extended) | component | UI (4-tab → 5-tab) | `src/renderer/components/BotSettingsPage.tsx` (existing) | self (extend) |
| `src/renderer/state/vault.ts` (NEW) | state | module-scope store + IPC subscription | `src/renderer/state/bots.ts` (ensureDaemonSubscription) | exact |
| `src/renderer/components/VaultReadBlock.tsx` (NEW) | component | UI block | `src/renderer/components/ToolResultBlock.tsx` | exact (collapse + error tint) |
| `src/renderer/components/VaultSearchBlock.tsx` (NEW) | component | UI block (matches list) | `src/renderer/components/ToolUseBlock.tsx` (collapse + JSON.stringify) | exact |
| `src/renderer/components/VaultWriteBlock.tsx` (NEW) | component | UI block (path + bytes written) | `src/renderer/components/ToolResultBlock.tsx` | exact |
| `src/renderer/components/MessageBlock.tsx` (extended) | component | dispatch by kind | `src/renderer/components/MessageBlock.tsx` (existing switch) | self (extend) |
| `tests/daemon/vault_glob.test.ts` (NEW) | test (unit) | picomatch pipeline | none — new | no-analog |
| `tests/daemon/vault_read.test.ts` (NEW) | test (unit) | safe_path + glob enforcement | `tests/unit/read_file.test.ts` | exact (mkdtemp + vi.mock electron) |
| `tests/daemon/vault_write.test.ts` (NEW) | test (unit) | Agents/<bot>/ containment + atomic write | `tests/unit/write_file.test.ts` | exact |
| `tests/daemon/vault_search.test.ts` (NEW) | test (unit) | rg spawn + glob filter | `tests/unit/code_search.test.ts` | exact |
| `tests/daemon/vault_config.test.ts` (NEW) | test (unit) | atomic JSON round-trip | `tests/unit/scheduler_persistence.test.ts` | exact |
| `tests/daemon/vault_wikilink.test.ts` (NEW) | test (unit) | regex + index case-fold | none — new | no-analog |
| `tests/e2e/obsidian-integration.test.ts` (NEW) | test (e2e) | Playwright smoke | `tests/playwright/daemon-tools.test.ts` | exact |
| `tests/fakes/fake-m3-server.ts` (extended) | test helper | SSE streaming | `tests/playwright/fake-m3-server.ts` (existing streamToolUseResponse) | self (extend) |

---

## Pattern Assignments

### `daemon/tools/vault_read.cjs` (NEW — tool, file-I/O + glob check)

**Analog:** `daemon/tools/read_file.cjs` (Phase 2 Wave 1, exact role match)
**Path:** `D:/Claude/Grokbot/daemon/tools/read_file.cjs`

**Imports pattern** (lines 1-12):
```javascript
const fs = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');
```

**Core read pattern** (lines 11-30) — vault_read mirrors this with safePath + glob check prepended:
```javascript
async function call(args, ctx) {
  const requested = args && args.path;
  const resolved = await safePath(ctx.workspaceRoot, requested);
  try {
    const content = await fs.readFile(resolved, 'utf8');
    return { content };
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`file not found: ${requested}`);
      err.code = 'enoent';
      throw err;
    }
    throw e;
  }
}
```

**Differences from analog:**
- `ctx.workspaceRoot` → `ctx.vaultRoot` (resolved at handler entry from `botCfg.vaultPath ?? globalCfg.rootPath`).
- Prepend `safePath(vaultRoot, requested)` then `checkVaultAccess({globalDeny, vaultDeny, vaultAllow, relativePath})`; throw `{code: 'glob_denied', reason, pattern}` on reject.
- Optional `startLine`/`endLine` slicing (mirrors Phase 2 `read_file` extension; not in current `read_file.cjs` but planned).
- Audit payload returns vault-relative path only (no absolute).

**Lines/structure:** ~80 lines. Exports `call(args, ctx)`. Module-scope `MAX_BYTES_DEFAULT = 256 * 1024`.

---

### `daemon/tools/vault_write.cjs` (NEW — tool, file-I/O + containment)

**Analog:** `daemon/tools/write_file.cjs` (Phase 2 Wave 1, exact role match)
**Path:** `D:/Claude/Grokbot/daemon/tools/write_file.cjs`

**Imports + atomic write pattern** (lines 9-37):
```javascript
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const content = args && args.content;

  if (typeof content !== 'string') {
    const err = new Error('content must be a string');
    err.code = 'invalid_content';
    throw err;
  }

  const resolved = await safePath(ctx.workspaceRoot, requested);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  try {
    await fs.writeFile(resolved, content, 'utf8');
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      throw Object.assign(new Error(`permission denied writing: ${requested}`), { code: 'eacces' });
    }
    throw e;
  }

  return { path: requested, bytesWritten: Buffer.byteLength(content, 'utf8') };
}
```

**Differences from analog:**
- Replace `safePath(workspaceRoot, requested)` with `safePath(vaultRoot, requested)` THEN second containment check: `path.relative(realpath('Agents/'+botId), resolved)` must not start with `..` — throws `{code: 'write_outside_agents'}`.
- Atomic write uses `tmp + rename` (RESEARCH §Pattern 3 + Pitfall 6); Phase 2 `write_file.cjs` is NOT atomic — vault_write should improve on it.
- Returns `{path: relativePath, bytesWritten}` (vault-relative, not the requested arg).

**Lines/structure:** ~100 lines. Exports `call(args, ctx)`.

---

### `daemon/tools/vault_search.cjs` (NEW — tool, file-I/O + ripgrep + glob filter)

**Analog:** `daemon/tools/code_search.cjs` (Phase 2 Wave 3, exact — the entire rg --json + readline + max_results structure is reused verbatim)
**Path:** `D:/Claude/Grokbot/daemon/tools/code_search.cjs`

**Core rg --json streaming pattern** (lines 78-275):
```javascript
async function call(
  { pattern, glob, path: searchPath, max_results = MAX_RESULTS_DEFAULT },
  ctx,
) {
  // Input validation (TOOL-05 probe + argv injection defense)
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw err('invalid_pattern', 'pattern must be a non-empty string');
  }
  if (pattern.length > PATTERN_MAX_BYTES) {
    throw err('pattern_too_long', 'pattern exceeds 1 MiB');
  }
  // ...
  const workspaceRoot = ctx && ctx.workspaceRoot;
  const resolvedPath = await safePath(workspaceRoot, requested);

  // Args as array — never shell:true. Pattern + glob + path validated for NUL bytes.
  const args = ['--json', '--no-messages', '--no-config', '--regexp', pattern];
  if (glob) args.push('--glob', glob);
  args.push(searchArg);
  // ...
  const child = spawn(rgPath, args, { cwd: workspaceRoot, stdio: [...], windowsHide: true });
  // Register for tools/cancel via ctx.registry.registerChild(toolCallId, child)
  // ... for-await loop, JSON.parse lines, cap at max_results, finally unregister
}
```

**Differences from analog:**
- Add `--no-follow` to args (Pitfall Open Question #2 mitigation; vault may have symlinks).
- After each `evt.type === 'match'`, compute `relPath = path.relative(vaultRoot, data.path.text).replace(/\\/g, '/')` and run `checkVaultAccess({globalDeny, vaultDeny, vaultAllow, relativePath: relPath})` — skip the match if `!access.allowed`.
- `ctx.workspaceRoot` → `ctx.vaultRoot`.
- Audit minimization: include `vaultRelativePath` per match (not full path) plus `{pattern, glob, max_results, result_count}` — matches `codeSearchAuditParams` shape (T-P2-21).

**Lines/structure:** ~250 lines. Mirrors `code_search.cjs` line-for-line with the glob filter step inserted.

---

### `daemon/tools/vault_list.cjs` (NEW — tool, file-I/O listing)

**Analog:** `daemon/tools/list_dir.cjs` (Phase 2 Wave 1, exact role match)
**Path:** `D:/Claude/Grokbot/daemon/tools/list_dir.cjs`

**Core list + sort pattern** (lines 12-53):
```javascript
const fs = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  const requested = args && args.path;
  const resolved = await safePath(ctx.workspaceRoot, requested);

  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw Object.assign(new Error(`directory not found: ${requested}`), { code: 'enoent' });
    }
    if (e && e.code === 'ENOTDIR') {
      throw Object.assign(new Error(`not a directory: ${requested}`), { code: 'not_a_directory' });
    }
    throw e;
  }

  const entries = dirents.map((d) => ({
    name: d.name,
    type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
    size: d.isFile() ? (d.size ?? null) : null,
  })).sort((a, b) => {
    if (a.type === b.type) {
      const al = a.name.toLowerCase();
      const bl = b.name.toLowerCase();
      return al === bl ? a.name.localeCompare(b.name) : al.localeCompare(bl);
    }
    return a.type === 'dir' ? -1 : 1;
  });

  return { entries };
}
```

**Differences from analog:**
- `ctx.workspaceRoot` → `ctx.vaultRoot`; prepend `checkVaultAccess` (no-op on writes but list is read-side).
- Skip hidden dirs by default (`.obsidian`, `.trash`) — configurable via `includeHidden` arg.
- Audit includes `{path: relativePath, entryCount}`.

**Lines/structure:** ~70 lines. Exports `call(args, ctx)`.

---

### `daemon/vault/config.cjs` (NEW — module, atomic JSON persistence)

**Analog:** `daemon/scheduler/index.cjs` (`readSchedulesFile` + `persistSchedules` — exact same shape)
**Path:** `D:/Claude/Grokbot/daemon/scheduler/index.cjs`

**Atomic JSON persistence pattern** (lines 50-100):
```javascript
const fs = require('node:fs');
const path = require('node:path');

function readSchedulesFile(userDataDir) {
  try {
    const raw = fs.readFileSync(schedulerPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.schedules)) return parsed.schedules;
    return [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}

function persistSchedules(userDataDir) {
  // Atomic tmp + rename. Serialized so concurrent callers don't interleave.
  const job = persistQueue.then(async () => {
    const entries = [...];
    const payload = JSON.stringify({ schedules: entries, updatedAt: new Date().toISOString() }, null, 2);
    const finalPath = schedulerPath(userDataDir);
    const tmp = `${finalPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  });
  return job;
}
```

**Differences from analog:**
- File is `<userData>/vault.json` (single object, not array); key shape `{rootPath: string, globalDeny: string[]}`.
- `loadVaultConfig(userDataDir)` returns `{rootPath: '', globalDeny: []}` on ENOENT or SyntaxError (defensive default — never throws).
- `saveVaultConfig(userDataDir, cfg)` validates `cfg.rootPath` is a string and `cfg.globalDeny` is a string array; throws `{code: 'invalid_vault_config'}` on shape mismatch.
- `vaultConfigPath(userDataDir)` helper returns `path.join(userDataDir, 'vault.json')`.

**Lines/structure:** ~120 lines. Exports `loadVaultConfig`, `saveVaultConfig`, `vaultConfigPath`, `__test__`.

---

### `daemon/vault/glob.cjs` (NEW — utility, picomatch glob pipeline)

**Analog:** none — picomatch is new in this project.
**Path:** N/A (new library dependency, RESEARCH.md §Standard Stack + Package Legitimacy Audit).

**picomatch pipeline pattern** (from RESEARCH.md §Pattern 2):
```javascript
const picomatch = require('picomatch');

function makeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return () => false;
  // dot: true so globs match .obsidian/, .trash/ — user may keep notes there
  return picomatch(patterns, { dot: true, nocase: false });
}

function checkVaultAccess({ globalDeny, vaultDeny, vaultAllow, relativePath }) {
  // 1. Global deny FIRST — applied to every bot, cannot be overridden.
  if (globalDeny && globalDeny.length) {
    const m = makeMatcher(globalDeny);
    if (m(relativePath)) {
      const pattern = globalDeny.find((p) => picomatch.isMatch(relativePath, p, { dot: true }));
      return { allowed: false, reason: 'global_deny', pattern };
    }
  }
  // 2. Per-bot deny.
  if (vaultDeny && vaultDeny.length) {
    const m = makeMatcher(vaultDeny);
    if (m(relativePath)) {
      const pattern = vaultDeny.find((p) => picomatch.isMatch(relativePath, p, { dot: true }));
      return { allowed: false, reason: 'vault_deny', pattern };
    }
  }
  // 3. Per-bot allow (empty allow = blocked by default).
  if (!vaultAllow || vaultAllow.length === 0) {
    return { allowed: false, reason: 'no_allowlist' };
  }
  const allow = makeMatcher(vaultAllow);
  if (!allow(relativePath)) {
    return { allowed: false, reason: 'not_in_allowlist' };
  }
  return { allowed: true };
}
```

**Lines/structure:** ~80 lines. Exports `makeMatcher`, `checkVaultAccess`, `__test__`.

---

### `daemon/vault/wikilink.cjs` (NEW — utility, regex + index lookup)

**Analog:** none — wikilink parsing is new.
**Path:** N/A (Pitfall 1 mitigation: regex `/\\[\\[([^\\]|]+)(?:#([^\]|]+))?(?:\\|([^\]]+))?\\]\\]/g` from RESEARCH.md §State of the Art).

**Wikilink regex + index pattern** (from RESEARCH.md §Pattern 4 + §Code Examples):
```javascript
const fs = require('node:fs/promises');
const path = require('node:path');

const WIKILINK_RE = /\[\[([^\]|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

function parseWikilinks(text) {
  const out = [];
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    out.push({ title: m[1], section: m[2] ?? null, alias: m[3] ?? null });
  }
  return out;
}

async function buildVaultIndex(vaultRoot) {
  const idx = new Map();  // nameLower → absolutePath
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.md') continue; // skip .obsidian, .trash
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        idx.set(e.name.replace(/\.md$/, '').toLowerCase(), full);
      }
    }
  }
  await walk(vaultRoot);
  return idx;
}

function resolveWikilink(index, name) {
  // Pitfall 1 mitigation: case-fold for case-insensitive lookup.
  return index.get(name.toLowerCase()) ?? null;
}
```

**Lines/structure:** ~90 lines. Exports `parseWikilinks`, `buildVaultIndex`, `resolveWikilink`.

---

### `daemon/vault/index.cjs` (NEW — module, barrel exports)

**Analog:** none — barrel.
**Lines/structure:** ~10 lines.
```javascript
const config = require('./config.cjs');
const glob = require('./glob.cjs');
const wikilink = require('./wikilink.cjs');

module.exports = {
  loadVaultConfig: config.loadVaultConfig,
  saveVaultConfig: config.saveVaultConfig,
  vaultConfigPath: config.vaultConfigPath,
  checkVaultAccess: glob.checkVaultAccess,
  makeMatcher: glob.makeMatcher,
  parseWikilinks: wikilink.parseWikilinks,
  buildVaultIndex: wikilink.buildVaultIndex,
  resolveWikilink: wikilink.resolveWikilink,
};
```

---

### `daemon/main.cjs` (extended — register tools + vault JSON-RPC methods)

**Analog:** self — `daemon/main.cjs` already has `bots/list`, `bots/create`, `bots/update`, etc.

**Tool registration pattern** (extend `case 'tools/call'` at lines 340-444, audit append already follows the canonical shape):
```javascript
const result = await registry.callTool(bot, name, args, {
  workspaceRoot,
  botDir,
  toolCallId,
  bot,
  userDataDir: userDataDirState,
  notify: sendNotification,
  requestApproval,
  signal: abortController.signal,
});
// audit.appendAudit({tool: name, bot, params: auditParams, outcome, durationMs, error, tool_use_id: toolCallId})
```

**JSON-RPC dispatch pattern for `vault/get_config` + `vault/set_config`** (mirror `bots/list` at lines 601-625):
```javascript
case 'vault/get_config': {
  const startedAt = Date.now();
  try {
    const cfg = vault.loadVaultConfig(userDataDirState);
    audit.appendAudit({ tool: 'vault.get_config', bot: currentBot, params: {}, outcome: 'ok', durationMs: Date.now() - startedAt });
    replyResult(id, { ok: true, config: cfg });
  } catch (err) {
    audit.appendAudit({ tool: 'vault.get_config', bot: currentBot, params: {}, outcome: 'error', durationMs: Date.now() - startedAt, error: { code: err.code || 'vault_get_config_failed', message: err.message } });
    replyError(id, err.code || 'vault_get_config_failed', err.message);
  }
  break;
}
```

**Differences:**
- Add 4 new tools to `registry.cjs#TOOLS` + `SCHEMAS`: `vault.read`, `vault.write`, `vault.search`, `vault.list` (and optionally `vault.wikilink_resolve`).
- Add 2 new JSON-RPC methods: `vault/get_config`, `vault/set_config`.
- In `tools/call` ctx, add `vaultRoot: vaultRootForBot(currentBot)` and `globalDeny: vaultConfig.globalDeny` (resolved on initialize + on every call so vault config edits take effect immediately — Pitfall 4).
- Extend `case 'initialize'` to load `schedulerCtx` analog for vault: `loadVaultConfig(userDataDirState)` → stash `currentVaultConfig`.

**Lines/structure:** adds ~120 lines.

---

### `daemon/bots/loader.cjs` (extended — ALLOWED_CONFIG_KEYS + writeConfigPatch)

**Analog:** self — Phase 4 + 6 extensions already follow this pattern.
**Path:** `D:/Claude/Grokbot/daemon/bots/loader.cjs`

**ALLOWED_CONFIG_KEYS extension pattern** (lines 19-36):
```javascript
const ALLOWED_CONFIG_KEYS = new Set([
  'id', 'name', 'persona', 'workspace', 'allowlist',
  'cron', 'cronEnabled', 'notifyOnError', 'scheduledPrompt',
  // Phase 7 additions:
  'vaultPath', 'vaultAllow', 'vaultDeny',
  'createdAt', 'updatedAt', 'status',
  'lastRunAt', 'lastRunExitReason', 'lastRunError',
  'schemaVersion',
]);
```

**writeConfigPatch per-key validation pattern** (lines 347-363 — mirrors existing cron/notifyOnError/scheduledPrompt guards):
```javascript
if (Object.prototype.hasOwnProperty.call(patch, 'cron')) {
  const c = patch.cron;
  if (c !== undefined && c !== '' && (typeof c !== 'string' || !CRON_REGEX.test(c))) {
    throw err('invalid_cron', `cron must be 5- or 6-field expression: ${c}`);
  }
}
```

**Differences:**
- Add `vaultPath` (string or null; `null` = explicit "no vault"; empty string falls back to global per Pitfall 8), `vaultAllow` (string[]), `vaultDeny` (string[]).
- Validate `vaultAllow` / `vaultDeny` are arrays of strings; reject non-string entries.
- Validate `vaultPath` is either undefined, null, or a string.

**Lines/structure:** adds ~30 lines to existing file.

---

### `src/main/ipc/vault.ts` (NEW — IPC bridge)

**Analog:** `src/main/ipc/bots.ts` (Phase 4 Wave 1, exact — `registerBotHandlers` shape).
**Path:** `D:/Claude/Grokbot/src/main/ipc/bots.ts`

**IPC handler registration pattern** (lines 34-40 + 48-60):
```typescript
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function registerBotHandlers(): void {
  ipcMain.handle(CHANNELS.BOTS_LIST, async (): Promise<BotListResult> => {
    try {
      const result = (await callBot('bots/list', {})) as { ok?: boolean; bots?: BotConfig[]; error?: string };
      return { ok: result?.ok === true, bots: [...], error: result?.error };
    } catch (err) {
      return { ok: false, bots: [], error: (err as Error).message };
    }
  });
  // ...
}
```

**Differences:** New file. Two handlers (`VAULT_GET_CONFIG`, `VAULT_SET_CONFIG`). On `VAULT_SET_CONFIG` success, `broadcast(CHANNELS.EVENT_VAULT_CONFIG_UPDATED, payload)` so renderer subscribers update. Validates `rootPath` is a string and `globalDeny` is a string array before forwarding to daemon.

**Lines/structure:** ~110 lines.

---

### `src/main/preload/index.ts` (extended — vault.* surface + EVENT_CHANNELS)

**Analog:** self — `src/main/preload/index.ts` already adds Phase 4/5/6 channels.
**Path:** `D:/Claude/Grokbot/src/main/preload/index.ts`

**EVENT_CHANNELS set extension pattern** (lines 7-30):
```typescript
const EVENT_CHANNELS = new Set<string>([
  CHANNELS.EVENT_MESSAGE_TOKEN,
  // ...
  CHANNELS.EVENT_NOTIFICATION_SCHEDULED_ERROR,
  CHANNELS.EVENT_NAVIGATE_TO_BOT,
]);
```

**api namespace pattern** (lines 60-70):
```typescript
bot: {
  list: () => ipcRenderer.invoke(CHANNELS.BOTS_LIST),
  create: (req) => ipcRenderer.invoke(CHANNELS.BOTS_CREATE, req),
  delete: (req) => ipcRenderer.invoke(CHANNELS.BOTS_DELETE, req),
  // ...
},
```

**Differences:**
- Add `CHANNELS.VAULT_GET_CONFIG`, `CHANNELS.VAULT_SET_CONFIG`, `CHANNELS.EVENT_VAULT_CONFIG_UPDATED` to EVENT_CHANNELS.
- Add `vault: { getConfig: () => ipcRenderer.invoke(CHANNELS.VAULT_GET_CONFIG), setConfig: (req) => ipcRenderer.invoke(CHANNELS.VAULT_SET_CONFIG, req) }` to `api` namespace.

**Lines/structure:** adds ~10 lines.

---

### `src/main/paths.ts` (extended — `vaultConfigPath()` helper)

**Analog:** self — `src/main/paths.ts` already exposes `workspaceRoot`, `botDir`, etc.
**Path:** `D:/Claude/Grokbot/src/main/paths.ts`

**Path helper pattern** (lines 14-26):
```typescript
export function auditDir(): string {
  return path.join(userDataDir(), 'audit');
}
export function keyFilePath(): string {
  return path.join(userDataDir(), 'api-key.bin');
}
```

**Differences:** add `export function vaultConfigPath(): string { return path.join(userDataDir(), 'vault.json'); }`.

**Lines/structure:** adds 3 lines.

---

### `src/shared/ipc-channels.ts` (extended — VAULT_* + EVENT_VAULT_CONFIG_UPDATED)

**Analog:** self — same file.
**Path:** `D:/Claude/Grokbot/src/shared/ipc-channels.ts`

**Channel constant pattern** (lines 18-30):
```typescript
BOTS_LIST: 'bots:list',
BOTS_CREATE: 'bots:create',
// ...
BOTS_RUNS: 'bots:runs',
```

**Event channel pattern** (lines 53-67):
```typescript
EVENT_BOT_LIST_UPDATED: 'bot:list:updated',
EVENT_BOT_STATUS: 'bot:status',
// ...
EVENT_NOTIFICATION_SCHEDULED_ERROR: 'notification:scheduled-error',
EVENT_NAVIGATE_TO_BOT: 'event:navigate-to-bot',
```

**Differences:** Add `VAULT_GET_CONFIG: 'vault:get_config'`, `VAULT_SET_CONFIG: 'vault:set_config'`, `EVENT_VAULT_CONFIG_UPDATED: 'vault:config:updated'`.

**Lines/structure:** adds 3 lines.

---

### `src/shared/types.ts` (extended — VaultConfig + MessageBlock variants + BotConfig fields)

**Analog:** self — `src/shared/types.ts` already extends `BotConfig` and `MessageBlock`.
**Path:** `D:/Claude/Grokbot/src/shared/types.ts`

**MessageBlock discriminated union pattern** (lines 11-28):
```typescript
export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'summary'; summary: SummaryRecord }
  | { kind: 'shell_stream'; shellId: string; ... };
```

**BotConfig interface extension pattern** (lines 331-358):
```typescript
export interface BotConfig {
  id: string;
  // ...
  notifyOnError?: boolean;
  scheduledPrompt?: string;
  createdAt: string;
  // ...
}
```

**Differences:**
- Add `vaultPath?: string | null; vaultAllow?: string[]; vaultDeny?: string[]` to `BotConfig`.
- Add `VaultGlobalConfig` interface (`{rootPath: string; globalDeny: string[]}`) + `VaultConfigResult`.
- Add 3 MessageBlock variants: `{kind: 'vault_read'; path: string; content: string; bytes: number}`, `{kind: 'vault_search'; query: string; matches: Array<{path: string; line: number; text: string}>; truncated: boolean}`, `{kind: 'vault_write'; path: string; bytesWritten: number}`.

**Lines/structure:** adds ~40 lines.

---

### `src/renderer/components/BotSettingsPage.tsx` (extended — add "obsidian" tab)

**Analog:** self — `BotSettingsPage.tsx` already extends to 4 tabs in Phase 6.
**Path:** `D:/Claude/Grokbot/src/renderer/components/BotSettingsPage.tsx`

**Tab pattern** (lines 20-27):
```typescript
type TabId = 'general' | 'permissions' | 'schedule' | 'history';
const TAB_IDS: TabId[] = ['general', 'permissions', 'schedule', 'history'];
const TAB_LABELS: Record<TabId, string> = {
  general: 'General', permissions: 'Permissions', schedule: 'Schedule', history: 'Run History',
};
```

**Per-tab blur save pattern** (lines 195-200):
```typescript
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const scheduleGeneralSave = () => {
  if (debounceRef.current) clearTimeout(debounceRef.current);
  debounceRef.current = setTimeout(() => {
    void persistPatch({...});
  }, 250);
};
```

**Differences:**
- Extend `TabId` to include `'obsidian'`; add to TAB_IDS + TAB_LABELS.
- Add `vaultPath`, `vaultAllow`, `vaultDeny` state hooks (initialize from `bot.vaultPath ?? ''`, `bot.vaultAllow ?? []`, `bot.vaultDeny ?? []`).
- Add `persistPatch` calls for the Obsidian tab; parse glob lists as newline-delimited textareas.
- Render `<input>` for vaultPath (text) + two `<textarea>` for allow/deny (one glob per line) + tool allowlist checkboxes for the 4 vault tools.

**Lines/structure:** adds ~150 lines.

---

### `src/renderer/state/vault.ts` (NEW — module-scope store + IPC subscription)

**Analog:** `src/renderer/state/bots.ts` (`ensureDaemonSubscription` pattern, exact).
**Path:** `D:/Claude/Grokbot/src/renderer/state/bots.ts`

**Module-scope store + subscription pattern** (lines 27-100):
```typescript
const state: BotsState = {
  bots: [],
  activeBotId: 'default',
  // ...
};
const subscribers = new Set<() => void>();
let subscribedToDaemon = false;

function ensureDaemonSubscription(): void {
  if (subscribedToDaemon) return;
  subscribedToDaemon = true;
  if (!window.localbot) return;
  const offList = window.localbot.on('bot:list:updated', () => { void refresh(); });
  const offNavigate = window.localbot.on('event:navigate-to-bot', (payload) => { ... });
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { offList(); offNavigate(); }, { once: true });
  }
}
```

**Differences:** New file. State: `{config: VaultGlobalConfig | null, loading, error}`. Subscribe to `EVENT_VAULT_CONFIG_UPDATED`. Export `useVaultConfig(): {config, refresh: () => Promise<void>}`.

**Lines/structure:** ~150 lines.

---

### `src/renderer/components/VaultReadBlock.tsx` (NEW — UI block)

**Analog:** `src/renderer/components/ToolResultBlock.tsx` (Phase 2 Wave 1, exact — collapse + error tint + byte-count).
**Path:** `D:/Claude/Grokbot/src/renderer/components/ToolResultBlock.tsx`

**Collapse + byte-count pattern** (lines 14-65):
```typescript
const COLLAPSE_THRESHOLD_BYTES = 500;
function utf8ByteLength(s: string): number { return new TextEncoder().encode(s).length; }
function sliceAtUtf8Bytes(s: string, maxBytes: number): string { /* ... */ }

export function ToolResultBlock({ content, isError }: ToolResultBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // ...
  const isSingleLine = !safe.includes('\n');
  const shouldCollapse = !isSingleLine && byteLen > COLLAPSE_THRESHOLD_BYTES;
  let visible = safe;
  if (shouldCollapse && !expanded) visible = sliceAtUtf8Bytes(safe, COLLAPSE_THRESHOLD_BYTES);
  // ...
  return <div className={`block-tool-result ${isError ? 'block-result-error' : ''}`}>...</div>;
}
```

**Differences:** Same component, different `data-block-kind="vault_read"` + display `path` header + `bytes` footer. Optionally pre-wrap content in `<pre>` for markdown.

**Lines/structure:** ~90 lines.

---

### `src/renderer/components/VaultSearchBlock.tsx` (NEW — UI block)

**Analog:** `src/renderer/components/ToolUseBlock.tsx` (Phase 2 Wave 1, exact — collapse + JSON.stringify).
**Path:** `D:/Claude/Grokbot/src/renderer/components/ToolUseBlock.tsx`

**Differences:** Renders match list (one `<div>` per match with path + line number + text), collapse pattern reuses `utf8ByteLength` + `sliceAtUtf8Bytes`. Header shows `query` + `truncated` flag if true.

**Lines/structure:** ~110 lines.

---

### `src/renderer/components/VaultWriteBlock.tsx` (NEW — UI block)

**Analog:** `src/renderer/components/ToolResultBlock.tsx` (same shape, smaller content).
**Differences:** Renders `path` (header) + `bytesWritten` (footer) + optional pre-write snippet. No collapse needed (small payload).

**Lines/structure:** ~60 lines.

---

### `src/renderer/components/MessageBlock.tsx` (extended — dispatch to new Vault*Block components)

**Analog:** self — `MessageBlock.tsx` already switches on `kind`.
**Path:** `D:/Claude/Grokbot/src/renderer/components/MessageBlock.tsx`

**Switch pattern** (lines 53-96):
```typescript
export function MessageBlock({ block, toolUseBlocks }: MessageBlockProps): React.JSX.Element | null {
  switch (block.kind) {
    case 'text': return <div className="block-text">{block.text}</div>;
    case 'tool_use': return <ToolUseBlock name={block.name} input={block.input} />;
    case 'tool_result': return <ToolResultBlock content={block.content} isError={block.isError} />;
    case 'summary': return (...);
    case 'shell_stream': return <ShellStreamBlock block={block} />;
    default: { const _exhaustive: never = block; return null; }
  }
}
```

**Differences:** Add 3 cases: `vault_read`, `vault_search`, `vault_write` returning the new components.

**Lines/structure:** adds ~15 lines.

---

### `tests/daemon/vault_read.test.ts` (NEW — test, unit)

**Analog:** `tests/unit/read_file.test.ts` (Phase 2 Wave 1, exact — mkdtemp + vi.mock electron pattern).
**Path:** `D:/Claude/Grokbot/tests/unit/read_file.test.ts` (read during session; verified pattern below.)

**Test infrastructure pattern:**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-read-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('vault.read', () => {
  it('reads a vault-relative file', async () => {
    // Setup: mkdir tmp/Projects, write tmp/Projects/foo.md
    // Call: vaultRead({ vaultRoot: tmp, globalDeny: [], vaultDeny: [], vaultAllow: ['Projects/**'], relativePath: 'Projects/foo.md' })
    // Assert: returns { content: '...' }
  });
  it('rejects global_deny match', async () => { ... });
  it('rejects when allowlist is empty', async () => { ... });
  // ...
});
```

**Differences:** Test vault root + glob pipeline (not workspace). Mock `safe_path` to return predictable paths in a tmp vault tree. Test Pitfall 5 (global deny precedence).

**Lines/structure:** ~200 lines. Minimum 8 cases (per VALIDATION.md row OBS-02).

---

### `tests/daemon/vault_write.test.ts` (NEW — test, unit)

**Analog:** `tests/unit/write_file.test.ts` (Phase 2 Wave 2, exact — atomic + containment).
**Path:** `D:/Claude/Grokbot/tests/unit/write_file.test.ts`

**Differences:** Test `Agents/<bot>/` containment — try writing to `Projects/foo.md` (outside) and `Agents/alpha/foo.md` (inside). Atomic write verification via `tmp + rename` pattern (read mid-write would show old or new, never partial).

**Lines/structure:** ~180 lines. Minimum 6 cases.

---

### `tests/daemon/vault_search.test.ts` (NEW — test, unit)

**Analog:** `tests/unit/code_search.test.ts` (Phase 2 Wave 3, exact — rg spawn + readline mocking).

**Differences:** Same rg --json mock setup + add glob filter assertions (skip matches outside vaultAllow, skip matches in globalDeny).

**Lines/structure:** ~220 lines. Minimum 8 cases.

---

### `tests/daemon/vault_config.test.ts` (NEW — test, unit)

**Analog:** `tests/unit/scheduler_persistence.test.ts` (Phase 6 Plan 1, exact — atomic JSON round-trip + corrupt handling).

**Differences:** Test `<userData>/vault.json` shape `{rootPath: '', globalDeny: []}` default + custom. Corrupt JSON fallback. Concurrent saves serialize via persistQueue (mirror `scheduler_persistence.test.ts`).

**Lines/structure:** ~150 lines. Minimum 6 cases.

---

### `tests/daemon/vault_glob.test.ts` (NEW — test, unit)

**Analog:** none — picomatch pipeline is new.
**Lines/structure:** ~120 lines. Test the 3-stage pipeline: globalDeny → vaultDeny → vaultAllow ordering. Pitfall 5 (global wins). Dotfile matching. Empty allowlist = blocked.

---

### `tests/daemon/vault_wikilink.test.ts` (NEW — test, unit)

**Analog:** none — wikilink parsing is new.
**Lines/structure:** ~100 lines. Test regex variants (`[[Note]]`, `[[Note|Alias]]`, `[[Note#Section]]`, `[[Note#Section|Alias]]`). Test case-fold index resolution. Test mtime-sweep cache invalidation (skip if not implementing).

---

### `tests/e2e/obsidian-integration.test.ts` (NEW — test, e2e)

**Analog:** `tests/playwright/daemon-tools.test.ts` (Phase 2 Wave 3, exact — fake-m3-server + audit assertion).
**Path:** `D:/Claude/Grokbot/tests/playwright/daemon-tools.test.ts`

**Differences:** Spawn daemon with `LOCALBOT_USER_DATA_DIR=<tmp>`; pre-create `<tmp>/vault/Projects/foo.md`. Send `initialize` then stream `vault.read` tool_use via fake-m3-server → assert `<pre>` content renders. Send `vault.search` → assert matches list. Send `vault.write` to `Agents/<bot>/foo.md` → assert file created + audit row carries vault-relative path only.

**Lines/structure:** ~250 lines.

---

### `tests/fakes/fake-m3-server.ts` (extended — streamVaultReadToolUse + write + search helpers)

**Analog:** self — `streamToolUseResponse` (lines 165-234) is the template.
**Path:** `D:/Claude/Grokbot/tests/playwright/fake-m3-server.ts`

**SSE tool_use envelope pattern** (lines 165-234):
```typescript
function streamToolUseResponse(res: http.ServerResponse, opts: StreamToolUseOpts): Promise<void> {
  const toolUseId = `toolu_fake_${Date.now().toString(36)}`;
  const inputJson = JSON.stringify(opts.input);
  // ... chunks array with message_start + content_block_start + input_json_delta + content_block_stop + message_delta + message_stop
  return writeSse(res, chunks);
}
```

**Differences:** Add `streamVaultReadToolUse`, `streamVaultWriteToolUse`, `streamVaultSearchToolUse` — each builds the same SSE envelope with the appropriate tool name. Export them so the new E2E test can import.

**Lines/structure:** adds ~80 lines.

---

## Cross-Cutting Patterns (Shared Across All Vault Files)

### 1. Tool Registration in `daemon/tools/registry.cjs`

**Source:** `daemon/tools/registry.cjs` (existing)
**Path:** `D:/Claude/Grokbot/daemon/tools/registry.cjs`

**TOOLS array + SCHEMAS pattern** (lines 15-28):
```javascript
const TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_dir', 'code_search',
  'memory.read', 'memory.write', 'memory.update', 'tree.list',
  'exec_command',
];
const SCHEMAS = { /* name → {name, description, input_schema} */ };
```

**fileFor + loadTool pattern** (lines 186-197):
```javascript
const TOOL_FILE = { 'tree.list': 'list_tree.cjs' };
function fileFor(name) { return TOOL_FILE[name] ?? name.replace(/\./g, '_') + '.cjs'; }
function loadTool(name) {
  if (loaded.has(name)) return loaded.get(name);
  const mod = require(`./${fileFor(name)}`);
  loaded.set(name, mod);
  return mod;
}
```

**Apply to:** Add `'vault.read', 'vault.write', 'vault.search', 'vault.list', 'vault.wikilink_resolve'` to TOOLS. Add 4-5 entries to SCHEMAS with input_schema (path, content, query, glob, maxResults, etc.).

### 2. IPC Channel Addition in `src/shared/ipc-channels.ts`

**Source:** `src/shared/ipc-channels.ts` (existing)
**Path:** `D:/Claude/Grokbot/src/shared/ipc-channels.ts`

**Channel constant pattern** (lines 3-71 — single `CHANNELS` object):
```typescript
export const CHANNELS = {
  SEND_MESSAGE: 'sendMessage',
  // ...
  EVENT_BOT_STATUS: 'bot:status',
} as const;
```

**Apply to:** Add `VAULT_GET_CONFIG: 'vault:get_config'`, `VAULT_SET_CONFIG: 'vault:set_config'`, `EVENT_VAULT_CONFIG_UPDATED: 'vault:config:updated'`.

### 3. Preload Bridge in `src/main/preload/index.ts`

**Source:** `src/main/preload/index.ts` (existing)
**Path:** `D:/Claude/Grokbot/src/main/preload/index.ts`

**EVENT_CHANNELS set + api namespace pattern** (lines 7-30 + 60-70):
```typescript
const EVENT_CHANNELS = new Set<string>([
  CHANNELS.EVENT_BOT_LIST_UPDATED, CHANNELS.EVENT_BOT_STATUS,
  // ...
]);
bot: {
  list: () => ipcRenderer.invoke(CHANNELS.BOTS_LIST),
  // ...
},
```

**Apply to:** Add 3 channel constants to EVENT_CHANNELS; add `vault: { getConfig, setConfig }` namespace.

### 4. Audit Minimization (3-key shape + per-tool delta)

**Source:** `daemon/main.cjs#tools/call` audit append (lines 432-440) + `codeSearchAuditParams` (lines 155-164) + `execCommandAuditParams` (lines 170-196) + `scheduler_tick` audit (per RESEARCH Phase 6 T-P6-19).

**Canonical audit shape:**
```javascript
audit.appendAudit({
  tool: name,
  bot,
  params: auditParams,  // NEVER includes absolute paths or sensitive content
  outcome,             // 'ok' | 'error'
  durationMs,
  error: errPayload,
  tool_use_id: toolCallId,
});
```

**Apply to vault tools:**
- `vault.read` audit `params`: `{ path: <relative>, bytes: <n> }` (NEVER absolute path; Pitfall 7).
- `vault.write` audit `params`: `{ path: <relative inside Agents/>, bytesWritten: <n> }`.
- `vault.search` audit `params`: `{ query, glob, result_count }` (mirrors `codeSearchAuditParams`).
- `vault.list` audit `params`: `{ path: <relative>, entryCount }`.
- `vault.get_config` / `vault.set_config`: `{ changedKeys: [...] }` (T-P4-17 pattern).

### 5. `safe_path` Containment Pattern (Phase 2)

**Source:** `daemon/tools/safe_path.cjs` (existing)
**Path:** `D:/Claude/Grokbot/daemon/tools/safe_path.cjs`

**Containment check pattern** (lines 15-72):
```javascript
async function safePath(workspaceRoot, requested) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw err('invalid_path', 'path is empty or not a string');
  }
  await fs.mkdir(workspaceRoot, { recursive: true });
  const rootReal = await fs.realpath(workspaceRoot);
  const joined = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(workspaceRoot, requested);
  // Walk up to deepest existing ancestor; throw outside_workspace on escape.
  // ...
  return resolvedReal;
}
```

**Apply to:** Every `vault.read`/`vault.search`/`vault.list` call uses `safePath(vaultRoot, requested)`. `vault.write` uses it as the FIRST layer; the SECOND layer (`Agents/<bot>/` containment) is layered on top.

### 6. ALLOWED_CONFIG_KEYS Schema Validation (Phase 4)

**Source:** `daemon/bots/loader.cjs` (existing)
**Path:** `D:/Claude/Grokbot/daemon/bots/loader.cjs`

**Schema validation pattern** (lines 19-92):
```javascript
const ALLOWED_CONFIG_KEYS = new Set([...]);
function validateConfig(cfg) {
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_CONFIG_KEYS.has(k)) throw err('invalid_config', `unknown config key: ${k}`);
  }
  // ... per-key type/range checks
}
```

**Apply to:** Extend ALLOWED_CONFIG_KEYS with `'vaultPath', 'vaultAllow', 'vaultDeny'`. Add per-key validation in both `validateConfig` (full cfg) and `writeConfigPatch` (patch only) — same shape as existing cron/notifyOnError/scheduledPrompt guards.

### 7. Atomic JSON Persistence Pattern (Phase 6)

**Source:** `daemon/scheduler/index.cjs#persistSchedules` (existing)
**Path:** `D:/Claude/Grokbot/daemon/scheduler/index.cjs`

**Atomic write pattern** (lines 66-100):
```javascript
function persistSchedules(userDataDir) {
  const job = persistQueue.then(async () => {
    const payload = JSON.stringify({ schedules: entries, updatedAt: new Date().toISOString() }, null, 2);
    const tmp = `${finalPath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, finalPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  });
  persistQueue = job;
  return job;
}
```

**Apply to:** `daemon/vault/config.cjs#saveVaultConfig` writes `<userData>/vault.json` atomically; corrupt-JSON load returns `{rootPath: '', globalDeny: []}` default.

### 8. Module-Scope Renderer Store + Subscription (Phase 4)

**Source:** `src/renderer/state/bots.ts` (existing)
**Path:** `D:/Claude/Grokbot/src/renderer/state/bots.ts`

**Subscription pattern** (lines 50-100):
```typescript
const state: BotsState = { ... };
const subscribers = new Set<() => void>();
let subscribedToDaemon = false;

function ensureDaemonSubscription(): void {
  if (subscribedToDaemon) return;
  subscribedToDaemon = true;
  const offList = window.localbot.on('bot:list:updated', () => { void refresh(); });
  const offNavigate = window.localbot.on('event:navigate-to-bot', (payload) => { ... });
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { offList(); offNavigate(); }, { once: true });
  }
}
```

**Apply to:** `src/renderer/state/vault.ts` follows the exact same pattern with `EVENT_VAULT_CONFIG_UPDATED` instead of `bot:list:updated`.

### 9. Discriminated `MessageBlock` Union (Phase 2)

**Source:** `src/shared/types.ts` + `src/renderer/components/MessageBlock.tsx`
**Paths:** `D:/Claude/Grokbot/src/shared/types.ts` (lines 11-28) + `D:/Claude/Grokbot/src/renderer/components/MessageBlock.tsx` (lines 53-96)

**Pattern:**
- Type union adds `{kind: 'X'; ...}` variant.
- Renderer switch dispatches to dedicated component.
- Exhaustiveness check via `const _exhaustive: never = block;`.

**Apply to:** Add `vault_read`, `vault_search`, `vault_write` variants; renderer switch dispatches to new components.

### 10. IPC Bridge Pattern (`registerBotHandlers` analog)

**Source:** `src/main/ipc/bots.ts` (existing)
**Path:** `D:/Claude/Grokbot/src/main/ipc/bots.ts`

**Pattern** (lines 34-60):
```typescript
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function registerBotHandlers(): void {
  ipcMain.handle(CHANNELS.BOTS_LIST, async () => {
    try {
      const result = (await callBot('bots/list', {})) as { ... };
      if (result?.ok) broadcast(CHANNELS.EVENT_BOT_LIST_UPDATED, { ... });
      return { ok: result?.ok === true, ... };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  // ...
}
```

**Apply to:** `src/main/ipc/vault.ts` exports `registerVaultHandlers()` with `VAULT_GET_CONFIG` + `VAULT_SET_CONFIG` handlers; on success broadcasts `EVENT_VAULT_CONFIG_UPDATED`.

### 11. URL Hash Sync Tab Pattern (Phase 6 BotSettingsPage)

**Source:** `src/renderer/components/BotSettingsPage.tsx` (existing)
**Path:** `D:/Claude/Grokbot/src/renderer/components/BotSettingsPage.tsx`

**Pattern** (lines 20-27, 40-50, 82-94):
```typescript
type TabId = 'general' | 'permissions' | 'schedule' | 'history';
const TAB_IDS: TabId[] = ['general', 'permissions', 'schedule', 'history'];
function parseTabFromHash(hash: string, botId: string): TabId { /* ... */ }
useEffect(() => {
  const desired = `#/bot/${bot.id}/settings/${activeTab}`;
  if (window.location.hash !== desired) window.history.replaceState(null, '', desired);
}, [activeTab, bot.id]);
```

**Apply to:** Extend `TabId` union with `'obsidian'`; add to TAB_IDS + TAB_LABELS; URL hash syncs to `obsidian` tab.

### 12. AppModal Primitive Reuse (Phase 4)

**Source:** `src/renderer/components/AppModal.tsx` (existing)
**Path:** `D:/Claude/Grokbot/src/renderer/components/AppModal.tsx`

**Pattern:** Generic modal with Escape close, click-outside close, focus trap. Use `<AppModal title="Obsidian vault" onClose={...}>...</AppModal>` for `VaultGlobalSettingsModal`.

**Apply to:** `VaultGlobalSettingsModal` wraps the AppModal primitive; provides a top-bar launch button in the renderer shell.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `daemon/vault/glob.cjs` | utility | glob matching | picomatch is a new dep; no existing glob helper in daemon |
| `daemon/vault/wikilink.cjs` | utility | regex + index | wikilink parsing is new; no existing Obsidian-related code |
| `daemon/vault/index.cjs` | module | barrel | trivially new; no analog |
| `tests/daemon/vault_glob.test.ts` | test (unit) | picomatch pipeline | mirrors no existing test; new behavior |
| `tests/daemon/vault_wikilink.test.ts` | test (unit) | regex + index | mirrors no existing test; new behavior |

For these files, the planner should reference `07-RESEARCH.md` §Pattern 2 (glob pipeline) and §Pattern 4 (vault index) directly.

---

## Metadata

**Analog search scope:** `daemon/tools/`, `daemon/bots/`, `daemon/scheduler/`, `daemon/audit.cjs`, `daemon/main.cjs`, `src/main/ipc/`, `src/main/preload/`, `src/main/paths.ts`, `src/shared/`, `src/renderer/state/`, `src/renderer/components/`, `tests/unit/`, `tests/playwright/`.

**Files scanned:** 17 daemon files, 12 main files, 15 renderer files, 5 shared files, 6 test files, 1 helper.

**Pattern extraction date:** 2026-09-19

**Tracked-source verification:** All analog paths above are git-tracked source files (verified via `git ls-files`):
- `daemon/tools/read_file.cjs`, `daemon/tools/write_file.cjs`, `daemon/tools/code_search.cjs`, `daemon/tools/list_dir.cjs`, `daemon/tools/safe_path.cjs`, `daemon/tools/registry.cjs` ✓
- `daemon/bots/loader.cjs`, `daemon/scheduler/index.cjs`, `daemon/audit.cjs`, `daemon/main.cjs` ✓
- `src/main/ipc/bots.ts`, `src/main/ipc/notifications.ts`, `src/main/preload/index.ts`, `src/main/paths.ts`, `src/main/daemon/spawn.ts` ✓
- `src/shared/types.ts`, `src/shared/ipc-channels.ts`, `src/shared/window.d.ts` ✓
- `src/renderer/state/bots.ts`, `src/renderer/components/MessageBlock.tsx`, `src/renderer/components/ToolUseBlock.tsx`, `src/renderer/components/ToolResultBlock.tsx`, `src/renderer/components/BotSettingsPage.tsx`, `src/renderer/components/AppModal.tsx` ✓
- `tests/playwright/fake-m3-server.ts`, `tests/playwright/daemon-tools.test.ts` ✓

No mirror paths (`.gsd/capabilities/...`) used.
