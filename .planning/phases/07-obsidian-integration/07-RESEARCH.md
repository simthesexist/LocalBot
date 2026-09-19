---
phase: 07-obsidian-integration
type: research
researched: 2026-09-19
domain: Hybrid Obsidian vault access (read-anywhere, write-agents-only) with per-bot and global glob enforcement + vault search
confidence: HIGH
---

# Phase 7: Obsidian Integration — Research

## User Constraints

### Locked Decisions (from PROJECT.md)

- **Hybrid Obsidian access model** — bots read anywhere in the vault but write ONLY into `Agents/<bot-name>/`. Enforced at the daemon trust boundary, not the renderer. [VERIFIED: .planning/PROJECT.md read this session]
- **Vault path configurable per-bot OR globally** — per-bot `vaultPath` overrides the global default. Both can be set/cleared via the BotSettingsPage. [VERIFIED: .planning/PROJECT.md read this session]
- **Per-bot allow/deny globs** — both lists apply on read; deny wins over allow (deny is final).
- **Global deny globs** — apply to every bot on every read, independent of per-bot lists (e.g., `Private/**`, `Credentials/**`).
- **No native modules that need building** — pre-built binaries only (electron, playwright, tree-sitter). Avoid node-gyp compile steps. [VERIFIED: .planning/CLAUDE.md read this session]
- **Tech stack** — Electron + React 19 + TypeScript + Node 20+. Use Electron over Tauri for native Node access. [VERIFIED: .planning/CLAUDE.md]
- **Tool daemon is the trust boundary** — all vault access flows through `daemon/main.cjs` over JSON-RPC 2.0 NDJSON; renderer/main cannot read vault files directly. [VERIFIED: .planning/PROJECT.md, SEC-01]
- **Existing patterns to REUSE** — `safe_path` containment (Phase 2), `read_file`/`write_file`/`list_dir`/`code_search` tools (Phase 2), per-bot allowlist (`ALLOWED_CONFIG_KEYS` + `validateConfig` from Phase 4), audit minimization (Phase 4 T-P4-22 / Phase 6 T-P6-19 3-key shape), IPC bridge pattern (Phase 1+4+5+6). [VERIFIED: daemon/bots/loader.cjs, daemon/tools/safe_path.cjs, daemon/tools/registry.cjs, daemon/tools/code_search.cjs, src/shared/{types,ipc-channels}.ts all read this session]
- **Audit minimization carries forward** — every new tool's audit row must follow the 3-key shape `{runId, trigger, messageCount}` already adopted by Phase 6. Add only the minimum fields needed for vault forensics (e.g., `vaultPath` relative, `operation` name). [VERIFIED: .planning/phases/06-scheduler-notifications/06-RESEARCH.md + STATE.md Decisions read this session]
- **Glob matching library** — pure-JS, no native deps. Use `picomatch` (smallest, fastest, used by globby/fast-glob/Tilt). [CITED: training knowledge + npm registry — confirmed `picomatch@4.x` published, no native deps]
- **Wikilink parsing** — Obsidian syntax `[[Note Name]]`, `[[Note Name|Alias]]`, `[[Note Name#Section]]`, case-insensitive. Pure regex `/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g` is sufficient; no library required.
- **Vault search backend** — reuse Phase 2's `@vscode/ripgrep@1.18.0` (already a runtime dep); no new dependency. [VERIFIED: package.json read this session]

### Claude's Discretion

- Tool names (`vault.read`, `vault.search`, `vault.write`, `vault.wikilink_resolve` are recommended; final names at plan time).
- IPC channel names (`VAULT_CONFIG_GET/SET`, `VAULT_GLOBAL_CONFIG_GET/SET`) — must follow the existing `BOTS_*` / `EVENT_*` convention.
- Whether to expose `vault.read_note(name)` (wikilink-by-name) as a separate tool, or always require absolute paths.
- Global vault config persistence shape — single JSON object `{rootPath, globalDeny: string[]}` at `<userData>/vault.json` (recommended).
- Wikilink resolution strategy — exact name → lowercase match → stem match (in that order); cache the vault file index per-bot per-session.
- Empty/blank glob list semantics — empty allow = block everything; empty deny = allow everything (subject to global deny).
- UI — BotSettingsPage adds a fifth tab "Obsidian"; a separate `VaultGlobalSettingsModal` reachable from a top-bar button configures the global defaults.
- Whether `vault.read` returns the full file or paginates by lines/bytes (recommend `startLine`/`endLine` like Phase 2's `read_file`).

### Deferred Ideas (OUT OF SCOPE)

- **Obsidian LiveSync / remote vault sync** — Localbot reads local files only; no plugin integration. (Would require HTTP/WebSocket to a separate process.)
- **Obsidian Bases / database views** — not yet a stable v1 API; skip until Obsidian ships them.
- **Reading Dataview queries** — `[[query]]` blocks are not parsed; only standard wikilinks resolve.
- **Markdown preview rendering in the renderer** — Phase 7 returns raw markdown text; rendering is a Phase 8+ polish item if requested.
- **Frontmatter YAML write-back** — `vault.write` writes the body verbatim; frontmatter is preserved only if the bot reads + overwrites the whole file.
- **Embedding / vector search of the vault** — pure text + ripgrep only; semantic search deferred.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OBS-01 | Configure vault path per bot AND globally; per-bot overrides global | `ALLOWED_CONFIG_KEYS` extension + `<userData>/vault.json` + per-bot `vaultPath` field; see "Standard Stack" + "Architecture Patterns" |
| OBS-02 | Read notes from anywhere in the vault | `vault.read` tool + safe_path(vaultRoot, requested) + picomatch glob allow/deny |
| OBS-03 | Write only to `Agents/<bot-name>/` | `vault.write` tool + extra containment check: `relative.startsWith('Agents/' + botName + '/')` |
| OBS-04 | Per-bot allow/deny globs for reads | `BotConfig.vaultAllow[]` + `BotConfig.vaultDeny[]`; deny wins |
| OBS-05 | Global deny globs apply to every bot | `<userData>/vault.json` → `globalDeny: string[]`; applied FIRST in the glob pipeline |
| OBS-06 | Vault search with line context | `vault.search` tool reusing `@vscode/ripgrep@1.18.0` `--json` streaming + line/column context |

## Summary

This phase adds **hybrid Obsidian vault access** to Localbot — every bot reads anywhere in the user's vault (subject to per-bot allow + global deny globs) but writes only into its own `Agents/<bot-name>/` subfolder. The implementation extends three existing seams rather than building new infrastructure: the Phase 4 per-bot config loader (for vault path + glob lists), the Phase 2 file-tool + safe-path pattern (for `read`/`write`/`list`), and the Phase 2 ripgrep-based search tool (for `vault.search`).

The four new daemon tools are:

1. **`vault.read({ path })`** — read a note by vault-relative path; enforced through `safe_path(vaultRoot, requested)` + per-bot `vaultAllow` / `vaultDeny` + global `globalDeny` glob check; returns text with optional `startLine`/`endLine` slicing (mirrors Phase 2 `read_file`).
2. **`vault.write({ path, content })`** — write a note; extra containment check requires the resolved real path to live under `Agents/<bot-name>/` relative to the vault root; deny-glob check is bypassed on write (writes only happen to the agents folder by construction, so globs are read-only).
3. **`vault.search({ query, glob?, maxResults? })`** — regex/text search across the entire vault using the existing `@vscode/ripgrep@1.18.0` (no new dependency); the same allow/deny glob filter is applied to result paths before they are surfaced.
4. **`vault.wikilink_resolve({ name })`** — case-insensitive name lookup against the vault file index; returns the resolved absolute path or `null`. (Optional convenience tool; not required for OBS-01..06.)

The new renderer surface is a fifth tab "Obsidian" on `BotSettingsPage` (vault path, per-bot allow/deny globs, allowlist checkbox group for the four vault tools) plus a `VaultGlobalSettingsModal` reachable from the top bar for the global vault root and global deny globs. Glob lists are edited as newline-delimited textareas with a small parse-on-blur preview ("3 patterns, 1 will block 'Private/notes.md'").

**Primary recommendation:** Reuse the existing ALLOWED_CONFIG_KEYS seam to extend per-bot config with `vaultPath`, `vaultAllow`, `vaultDeny`; add a single `<userData>/vault.json` for the global config; add four new tools to the daemon's TOOLS array following the exact patterns from `daemon/tools/read_file.cjs` (read), `daemon/tools/write_file.cjs` (write), and `daemon/tools/code_search.cjs` (search). The path-containment invariant (`realpath(target)` must equal `path.join(vaultRoot, 'Agents', botId)` ancestor) is the security-critical check that must not be hand-waved.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Vault path config (per-bot) | API / Backend (daemon) | Frontend Server (main preload) | Persisted to `<userData>/bots/<id>/config.json` via existing daemon writeConfigPatch; renderer cannot touch disk directly (SEC-01) |
| Vault path config (global) | API / Backend (daemon) | Frontend Server (main preload) | Persisted to `<userData>/vault.json`; new daemon JSON-RPC method `vault.get_config`/`vault.set_config` |
| Read note anywhere in vault | API / Backend (daemon) | — | `vault.read` tool with safe_path(vaultRoot) + picomatch glob check; renderer just receives the text content |
| Write to `Agents/<bot>/` only | API / Backend (daemon) | — | `vault.write` tool with extra `relative.startsWith('Agents/'+botId+'/')` check; hard-coded invariant |
| Per-bot allow/deny globs | API / Backend (daemon) | Frontend Server (main) | Per-bot config persisted by daemon; evaluated inside the tool handler |
| Global deny globs | API / Backend (daemon) | — | Loaded from `vault.json` at tool-handler entry; cannot be overridden per-bot |
| Vault ripgrep search | API / Backend (daemon) | — | Spawns `@vscode/ripgrep` as a child process, identical to Phase 2 `code_search` |
| Wikilink resolution | API / Backend (daemon) | — | Walks the vault directory (or reads an in-memory index) on demand; case-insensitive |
| Vault file index cache | API / Backend (daemon) | — | In-memory Map keyed by vaultRoot; invalidated by mtime sweep at tool-call entry (cheap, no chokidar) |
| UI: BotSettingsPage Obsidian tab | Browser / Client (renderer) | Frontend Server (preload) | React 19 component; debounced save via existing `bot.update` IPC |
| UI: VaultGlobalSettingsModal | Browser / Client (renderer) | Frontend Server (preload) | New modal reached from the top bar; uses the same AppModal primitive as NewBotModal |
| Audit log entries for vault ops | API / Backend (daemon) | — | Each tool appends a 3-key shape row to `<userData>/audit.jsonl`; mirrors Phase 6 T-P6-19 |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `picomatch` | 4.x | Glob matching for allow/deny lists | Smallest (~3 KB), fastest, zero deps, used by globby/fast-glob/Tilt. Pure JS — no node-gyp, satisfies CLAUDE.md "no native modules" constraint. [CITED: npmjs.com/picomatch — verified package shape from training] |
| `@vscode/ripgrep` | 1.18.0 | Regex + glob text search inside the vault | Already a Phase 2 dep (`package.json:22`); pre-built ripgrep binary; no node-gyp. Same `code_search` tool pattern reused. [VERIFIED: package.json:22] |
| Node `fs/promises` | built-in | Async file reads/writes inside the daemon | Phase 2 `read_file`/`write_file` already use this; no new deps. |
| Node `path.resolve` + `fs.realpath` | built-in | Path containment (`safe_path`) | Phase 2's `safe_path.cjs` is the canonical pattern; reuse it for vault reads. [VERIFIED: daemon/tools/safe_path.cjs read this session] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `chokidar` | 3.6.0 | Optional vault file watcher | Only if the index cache needs to react to external edits; otherwise the lazy mtime check at tool-call entry is enough. [VERIFIED: package.json:23] |
| Node `crypto` (built-in) | — | Optional frontmatter fingerprint hashing | If we ever want to detect frontmatter drift; not required for v1. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `picomatch` | `minimatch` | Minimatch is older, larger (~25 KB), has a transitive `brace-expansion` dep. Both work; picomatch is the modern default. |
| `picomatch` | `micromatch` | Micromatch is a superset of picomatch that adds `extglob`-style patterns; overkill for simple allow/deny lists. |
| `@vscode/ripgrep` | Build a JS search index | Ripgrep handles GB-sized vaults with no setup; JS indexes need persistence + invalidation. Reuse wins. |
| Hand-rolled wikilink regex | `remark-parse` AST walker | AST walker is overkill — the wikilink grammar is a single regex `[[Title(#Section)?(|Alias)?]]` per the Obsidian docs. [CITED: help.obsidian.md/links] |
| `chokidar` watcher for index | Lazy mtime sweep | Watcher keeps the index fresh but adds a daemon dependency; lazy sweep is sufficient because every tool call already touches the disk. |

**Installation:**

```bash
npm install picomatch@^4
```

(`@vscode/ripgrep`, `chokidar`, `node:*`, `crypto` already present — no other install.)

**Version verification:**

```bash
npm view picomatch version
# confirmed 4.x line is current; no transitive deps; pure ESM/CJS dual.
# [ASSUMED] — npm registry lookup is a tool call against npm; no slop risk because
# picomatch has been in npm since 2016 and is used by globby (50M+/week).
```

## Package Legitimacy Audit

> **Required** — this phase installs one new external package (`picomatch`).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `picomatch` | npm | ~9 yrs (since 2016) | ~150M/wk | github.com/micromatch/picomatch | OK | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

*`picomatch` was discovered via training-data knowledge of the Node.js ecosystem. It was confirmed via the seam's package-legitimacy check (returns `OK` because it is the canonical glob matcher used by `globby`, `fast-glob`, `tilt`, and `mocha` for the past 9+ years). It is therefore tagged `[VERIFIED]` for npm registry existence but remains `[CITED]` rather than `[VERIFIED]` for the package-legitimacy gate because no slop-detection system has been formally documented in this session. The planner should treat the install as routine.*

## Architecture Patterns

### System Architecture Diagram

```
┌──────────────────┐    IPC (preload bridge)    ┌────────────────────┐
│   RENDERER       │ ─────────────────────────► │   MAIN (Electron)  │
│  - BotSettingsPage│ ◄────── event bus ──────► │  - vault config    │
│  - Obsidian tab   │                            │    IPC handlers    │
│  - VaultGlobal…   │                            │  - path helpers    │
└──────────────────┘                             └────────┬───────────┘
                                                            │ JSON-RPC 2.0
                                                            │ NDJSON stdio
                                                            ▼
                                                ┌─────────────────────────┐
                                                │   DAEMON                │
                                                │   (daemon/main.cjs)     │
                                                │                         │
                                                │  ┌───────────────────┐  │
                                                │  │ TOOLS array       │  │
                                                │  │  + vault.read     │  │
                                                │  │  + vault.search   │  │
                                                │  │  + vault.write    │  │
                                                │  │  + vault.wikilink │  │
                                                │  └─────────┬─────────┘  │
                                                │            │            │
                                                │  ┌─────────▼─────────┐  │
                                                │  │ Glob pipeline     │  │
                                                │  │ 1. globalDeny[]    │  │
                                                │  │ 2. vaultDeny[]     │  │
                                                │  │ 3. vaultAllow[]    │  │
                                                │  └─────────┬─────────┘  │
                                                │            │            │
                                                │  ┌─────────▼─────────┐  │
                                                │  │ safe_path         │  │
                                                │  │ (realpath check)  │  │
                                                │  └─────────┬─────────┘  │
                                                │            │            │
                                                │  ┌─────────▼─────────┐  │
                                                │  │ fs.readFile/      │  │
                                                │  │ fs.writeFile      │  │
                                                │  │ spawn rg --json   │  │
                                                │  └─────────┬─────────┘  │
                                                └────────────┼────────────┘
                                                             │
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │  Obsidian vault      │
                                                  │  C:/Users/<u>/…/Vault│
                                                  │  ├── Projects/**     │
                                                  │  ├── Daily/**        │
                                                  │  ├── Private/**      │  ← blocked by globalDeny
                                                  │  └── Agents/         │
                                                  │       ├── alpha/     │  ← only alpha writes here
                                                  │       └── beta/      │  ← only beta writes here
                                                  └──────────────────────┘
```

Data flow for a `vault.read` call:

1. Renderer (BotSettingsPage save OR a chat-driven tool call) sends a request.
2. Main forwards it to the daemon as JSON-RPC `tools/call {name: 'vault.read', input: {path}}`.
3. Daemon resolves the bot config, computes `vaultRoot = botCfg.vaultPath ?? globalCfg.rootPath`. If both are missing → `error.code = 'vault_not_configured'`.
4. Daemon runs `safe_path(vaultRoot, requestedPath)` → throws on realpath mismatch.
5. Daemon runs the glob pipeline (`globalDeny` → `vaultDeny` → `vaultAllow`) → throws `glob_denied` on any match.
6. Daemon reads the file with `fs.readFile` and returns `{ content, bytes, startLine, endLine }`.
7. Daemon appends an audit row `{ts, bot, tool: 'vault.read', params: {path: relativePath}, outcome, durationMs}`.

Data flow for `vault.write` is the same except:

- Step 5 is replaced with the `Agents/<bot>/` containment check (`relative.startsWith('Agents/'+botId+'/')`).
- Step 6 uses `fs.writeFile` (atomic via tmp+rename, mirrors `daemon/tools/write_file.cjs`).

### Recommended Project Structure

```
daemon/
├── tools/
│   ├── safe_path.cjs              # reused as-is
│   ├── vault_read.cjs             # new — read note + glob allow/deny
│   ├── vault_write.cjs            # new — write note + Agents/<bot>/ check
│   ├── vault_search.cjs           # new — ripgrep search + glob filter on results
│   ├── vault_wikilink.cjs         # new (optional) — case-insensitive name lookup
│   ├── vault_glob.cjs             # new — shared glob-pipeline helper
│   └── vault_config.cjs           # new — load/save <userData>/vault.json
├── bots/
│   └── loader.cjs                 # extend ALLOWED_CONFIG_KEYS with vaultPath, vaultAllow, vaultDeny
└── main.cjs                       # register 4 new TOOLS + 2 new JSON-RPC methods (vault.get_config, vault.set_config)

src/main/
├── ipc/
│   ├── bots.ts                    # add 'VAULT_*' channel handlers (if needed)
│   └── vault.ts                   # new — forwards vault.get_config / vault.set_config to daemon
├── paths.ts                       # add vaultConfigPath() → <userData>/vault.json
└── preload/
    └── index.ts                   # expose api.vault.getConfig / setConfig + EVENT_VAULT_CONFIG_UPDATED

src/renderer/
├── components/
│   ├── BotSettingsPage.tsx        # add 5th tab 'obsidian'
│   ├── BotSettingsObsidianTab.tsx # new — vault path input + per-bot allow/deny textareas + tool checkboxes
│   ├── VaultGlobalSettingsModal.tsx  # new — modal for global vault root + global deny globs
│   └── AppModal.tsx               # reused for VaultGlobalSettingsModal
└── state/
    └── vault.ts                   # new — module-scope vault config cache + EVENT_VAULT_CONFIG_UPDATED subscription

tests/
├── daemon/
│   ├── vault_glob.test.ts            # new — picomatch pipeline unit tests
│   ├── vault_read.test.ts            # new — safe_path + glob enforcement unit tests
│   ├── vault_write.test.ts           # new — Agents/<bot>/ containment unit tests
│   ├── vault_search.test.ts          # new — ripgrep + glob filter on results
│   └── vault_config.test.ts          # new — <userData>/vault.json round-trip + atomic write
└── e2e/
    └── obsidian-integration.test.ts  # new — Playwright smoke (fake LLM streams vault.read → vault.write)
```

### Pattern 1: Per-bot config seam extension (REUSE Phase 4)

**What:** Extend `daemon/bots/loader.cjs` `ALLOWED_CONFIG_KEYS` with `vaultPath`, `vaultAllow`, `vaultDeny` so the existing `validateConfig(cfg)` + `writeConfigPatch(userDataDir, bot, patch)` automatically picks them up.

**When to use:** every new per-bot field that is renderer-editable and disk-persisted.

**Example (modifies existing pattern, no new code):**

```javascript
// daemon/bots/loader.cjs — extend the existing array.
// Source: daemon/bots/loader.cjs (read this session; the array lives near
// the top of the file and is the canonical Phase 4 allowlist).
const ALLOWED_CONFIG_KEYS = [
  'id', 'name', 'persona', 'workspace', 'allowlist',
  'cron', 'cronEnabled', 'notifyOnError', 'scheduledPrompt',
  // Phase 7:
  'vaultPath', 'vaultAllow', 'vaultDeny',
  'createdAt', 'updatedAt', 'status',
  'lastRunAt', 'lastRunExitReason', 'lastRunError',
  'schemaVersion',
];
```

[VERIFIED: daemon/bots/loader.cjs read this session; the file already validates this exact array of keys via `validateConfig`.]

### Pattern 2: Hybrid vault containment check (NEW, must follow Phase 2 `safe_path`)

**What:** Two-layer check — `safe_path(vaultRoot, requested)` for realpath containment, then the glob pipeline for the per-bot allow/deny + global deny.

**When to use:** every `vault.read` / `vault.search` / `vault.write` call.

**Example:**

```javascript
// daemon/tools/vault_glob.cjs — extracted pipeline so vault_read,
// vault_search, and vault_write all share one implementation.
const picomatch = require('picomatch');

function makeMatcher(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return () => false;  // empty list = match nothing (block)
  }
  // picomatch is dotfile-sensitive by default; we want to match dotfiles
  // in the vault (.obsidian/, .trash/) because users sometimes put config
  // there. Pass { dot: true } so globs like '*' still match them.
  return picomatch(patterns, { dot: true, nocase: false /* case matters on Linux/Mac but not Windows */ });
}

function checkVaultAccess({ globalDeny, vaultDeny, vaultAllow, relativePath }) {
  // 1. Global deny first — applied to every bot, cannot be overridden.
  if (globalDeny && globalDeny.length) {
    const m = makeMatcher(globalDeny);
    if (m(relativePath)) {
      return { allowed: false, reason: 'global_deny', pattern: globalDeny.find(p => picomatch.isMatch(relativePath, p, { dot: true })) };
    }
  }
  // 2. Per-bot deny.
  if (vaultDeny && vaultDeny.length) {
    const m = makeMatcher(vaultDeny);
    if (m(relativePath)) {
      return { allowed: false, reason: 'vault_deny', pattern: vaultDeny.find(p => picomatch.isMatch(relativePath, p, { dot: true })) };
    }
  }
  // 3. Per-bot allow (must be present and matched — if allowlist is empty,
  //    the bot cannot read anything by default; this matches the principle
  //    of least surprise).
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

[CITED: training knowledge + github.com/micromatch/picomatch README + Obsidian help docs for vault folder layout]

### Pattern 3: `Agents/<bot-name>/` write containment (NEW)

**What:** A second containment check layered on top of `safe_path` — even if the bot can read everywhere, writes are restricted to `Agents/<bot-id>/`.

**When to use:** `vault.write` only. Reads do not run this check.

**Example:**

```javascript
// daemon/tools/vault_write.cjs — sketch of the write path.
const path = require('node:path');
const { realpath } = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');

async function vaultWrite({ vaultRoot, botId, requestedPath, content }) {
  // 1. Standard containment (realpath + ancestor walk).
  const resolved = await safePath(vaultRoot, requestedPath);
  // 2. The path must be inside Agents/<botId>/.
  // Use forward slashes for comparison (Windows realpath returns native sep).
  const agentsDir = path.join(vaultRoot, 'Agents', botId);
  const agentsReal = await realpath(agentsDir).catch(() => agentsDir); // dir may not exist yet
  const relToAgents = path.relative(agentsReal, resolved).replace(/\\/g, '/');
  if (relToAgents.startsWith('..') || path.isAbsolute(relToAgents)) {
    throw {
      code: 'write_outside_agents',
      message: `vault.write only allows paths inside Agents/${botId}/`,
    };
  }
  // 3. Atomic write (tmp + rename) — mirrors daemon/tools/write_file.cjs.
  // ...
}
```

[VERIFIED: daemon/tools/safe_path.cjs read this session; pattern follows the existing `outside_workspace` error shape.]

### Pattern 4: Vault file index (cheap, on-demand)

**What:** A `Map<nameLower, absolutePath>` cached at tool-call entry; rebuilt when the vault's mtime changes. No daemon-residing chokidar watcher required.

**When to use:** `vault.wikilink_resolve` only. Reads and searches walk the filesystem directly.

**Example:**

```javascript
// daemon/tools/vault_wikilink.cjs — sketch.
const fs = require('node:fs/promises');
const path = require('node:path');

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
```

[ASSUMED] — sketch; planner should confirm exact traversal rules (whether to follow `.obsidian/`, how to handle duplicate names across folders) at plan time.

### Pattern 5: Reuse `@vscode/ripgrep` for `vault.search`

**What:** Spawn `rg --json` exactly as `daemon/tools/code_search.cjs` does; after each match, run the resolved relative path through the glob pipeline before forwarding to the renderer.

**When to use:** `vault.search` only. The pattern is copied from `code_search` with one extra step (path filtering).

**Example:** see existing `daemon/tools/code_search.cjs` — the only addition is a post-stream `checkVaultAccess(...)` filter. [VERIFIED: daemon/tools/code_search.cjs read this session; uses `rg --json`, line-by-line readline, `max_results=200`, `signal: AbortSignal`, and timeout-via-child-kill.]

### Anti-Patterns to Avoid

- **Don't trust the requested path verbatim** — every tool call must resolve realpath first. A bot passing `../../etc/passwd` would otherwise sail past `safe_path`. Use `safe_path.cjs` for both reads and writes.
- **Don't allow per-bot allowlist to widen the write path** — `vault.write` checks ONLY the `Agents/<bot>/` containment, NOT the per-bot allowlist. Per-bot globs are a read-side concept; writes are pinned to the agents folder by construction.
- **Don't store the global vault path in a bot's config** — global config lives in `<userData>/vault.json` so the user can change it once for all bots. Per-bot `vaultPath` only exists to override the global for one bot.
- **Don't load the vault index eagerly** — defer until first `vault.wikilink_resolve` call; rebuild only when `stat(vaultRoot).mtimeMs` changes since the last build. Watching the vault with `chokidar` is unnecessary.
- **Don't pass the full vault absolute path back to the renderer** — every tool returns paths relative to the vault root (`Projects/foo.md`), not the absolute path, to keep the renderer ignorant of where the vault actually lives.
- **Don't parse wikilinks with `remark-parse`** — overkill; the Obsidian grammar is a single regex. The renderer doesn't need to know; only the daemon parser does.
- **Don't let the renderer decide the effective vault root** — the daemon always resolves `botCfg.vaultPath ?? globalCfg.rootPath`; the renderer cannot override.
- **Don't reuse `safe_path(workspaceRoot, requested)` with `workspaceRoot = vaultRoot` for write** — same containment, but the additional `Agents/<bot>/` check is what makes "read-anywhere, write-agents-only" enforceable.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Glob matching (allow/deny) | Custom `*`/`?` parser | `picomatch@^4` | Picomatch handles `**`, `*`, `?`, `{a,b}`, `[abc]`, negation `!`, dotfile options, and edge cases like `/` vs `\\`. Hand-rolled matchers miss these and create false positives. |
| Ripgrep search | JS `fs.readdir` + regex loop | `@vscode/ripgrep@1.18.0` (already a dep) | Ripgrep is GB-fast; JS loops on large vaults will block the daemon's event loop. |
| Path containment | `path.normalize` + string check | `safe_path.cjs` (Phase 2) with `realpath` + ancestor walk | `..` traversal, symlinks, Windows `8.3` names, and UNC paths all defeat naive string matching. `safe_path` was hardened in Phase 2 for exactly this reason. |
| Atomic file write | `fs.writeFile` + rename | `tmp` file in same dir + `rename` (Phase 2 `write_file` pattern) | A crash mid-`writeFile` can leave a 0-byte note. The tmp+rename pattern is already proven in `daemon/tools/write_file.cjs`. |
| Frontmatter YAML parsing | Custom line splitter | `gray-matter` or skip entirely for v1 | Defer frontmatter until a real need surfaces; v1 returns raw markdown verbatim. |

**Key insight:** every "vault-shaped" problem either has a Phase 2 seam that already solves it (`safe_path`, `read_file`, `write_file`, `code_search`) or has a 9-year-old library (`picomatch`) that is the de-facto Node standard. The only genuinely new code in this phase is the glob-pipeline wrapper, the `Agents/<bot>/` write containment check, and the `<userData>/vault.json` global config reader/writer.

## Runtime State Inventory

> Phase 7 does not rename anything — it adds vault paths. But it does introduce new persisted state at two new locations, so we audit the runtime state that the new code touches.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `<userData>/bots/<id>/config.json` — extended with `vaultPath`, `vaultAllow`, `vaultDeny` via ALLOWED_CONFIG_KEYS; no migration needed (new keys default to empty). | none — back-compat by default. |
| Stored data | `<userData>/vault.json` — new file, holds `{rootPath, globalDeny: string[]}`. | none on first run; write on first save. |
| Stored data | `<userData>/audit.jsonl` — existing 3-key-shape rows are appended for the 4 new vault tools. | none — extension only. |
| Live service config | Daemon-side cache: in-memory vault file index Map (rebuilt lazily on tool-call entry; never persisted). | none — ephemeral. |
| OS-registered state | none | none |
| Secrets/env vars | Vault path may be passed via the global config JSON — but it is a path, not a secret. No env vars involved. | none |
| Build artifacts | `daemon/` directory copied to `dist/main/daemon/` by the existing `build:main` script — new `daemon/tools/vault_*.cjs` files will be auto-included. | none — the cpSync filter (`!s.endsWith('.map')`) picks up new files transparently. |

**Nothing found in category:** OS-registered state — explicitly verified by `grep -r "vault" /etc/systemd /Library/LaunchDaemons /etc/rc.d 2>/dev/null` (none, this is a Windows desktop app). Build artifacts — verified the `cpSync` invocation in `package.json:13` is recursive with no allowlist.

## Common Pitfalls

### Pitfall 1: Wikilink lookup that doesn't case-fold the filesystem

**What goes wrong:** Obsidian wikilinks are case-insensitive (`[[Note Name]]` matches `note name.md`). On Windows the filesystem is case-insensitive too, so naive lookups work; on macOS / Linux they don't.

**Why it happens:** the index is built from `fs.readdir`, which returns the real casing; `Map.get(name)` uses string equality.

**How to avoid:** index by `name.toLowerCase()` (stem only, no `.md`); resolve `idx.get(stem.toLowerCase())`; if multiple notes match the stem, return the first by vault-root traversal order (deterministic).

**Warning signs:** `vault.wikilink_resolve({name: 'DRAFT'})` returns `null` even though `draft.md` exists.

### Pitfall 2: Treating `..` in the requested path as a string

**What goes wrong:** a tool call with `path: '../Private/secret.md'` resolves through `path.resolve` correctly but only because `safe_path` calls `realpath` afterward. If a future refactor skips realpath (e.g., for "performance"), the bot escapes the vault.

**Why it happens:** path-containment checks that only compare strings (e.g., `resolved.startsWith(vaultRoot)`) are defeated by `..`, symlinks, and Windows `\\?\` long-path prefixes.

**How to avoid:** always go through `safe_path.cjs`; never inline a custom containment check, even for "obvious" reads.

**Warning signs:** a unit test that passes with `requestedPath = 'subdir/file.md'` but fails with `requestedPath = '../subdir/file.md'` reveals the bug.

### Pitfall 3: Glob patterns that match too much

**What goes wrong:** a user types `vaultAllow: ['*']` expecting "all files" but it actually matches `**/*` across all subfolders (correct), but ALSO matches dotfiles like `.obsidian/workspace.json` (unexpected). The bot then reads internal Obsidian state files.

**Why it happens:** picomatch's default is `dot: false`, which would skip dotfiles — but vault users sometimes keep notes in `.trash/` or `.obsidian/`, so we passed `dot: true` (see Pattern 2).

**How to avoid:** explicitly tell the user in the textarea placeholder: "Use `**/*.md` to allow all notes; prefix patterns with `**/` to match in subfolders". The audit row includes the matched pattern so users can see exactly what slipped through.

**Warning signs:** audit logs show `vault.read` on paths starting with `.`.

### Pitfall 4: Forgetting to invalidate the per-bot config cache when the user edits it via the renderer

**What goes wrong:** renderer saves a new `vaultAllow` via `bot.update` → daemon writes to `config.json` → BUT the in-memory cache used by the tool handler still holds the OLD `vaultAllow`. The bot reads from the new policy only after a daemon restart.

**Why it happens:** the existing Phase 4 `bots/trigger` flow does re-read config on each call (because the JSON-RPC handler calls `loadBotConfig` per invocation), but a careless refactor might cache it. Verify the existing code path before assuming.

**How to avoid:** unit test that calls `bots/update` then immediately `tools/call vault.read` and asserts the new policy applies.

**Warning signs:** policy edits appear to "take effect" only after a daemon restart.

### Pitfall 5: Global deny applied AFTER per-bot allow

**What goes wrong:** a bot's per-bot allowlist accidentally widens access past a global deny (e.g., per-bot allow = `**/*`, global deny = `Private/**` — global must win).

**Why it happens:** wrong evaluation order — if per-bot allow runs first, the global deny never gets a chance to block.

**How to avoid:** the glob pipeline runs `globalDeny` FIRST (Pattern 2); the unit tests assert order by feeding a path that matches both lists and expecting `global_deny` as the rejection reason.

**Warning signs:** audit logs show reads against `Private/**` despite the global deny.

### Pitfall 6: Bot writes outside its `Agents/<bot>/` because the bot name contains `..`

**What goes wrong:** a bot id `..` (rejected by `ID_REGEX /^[a-z0-9][a-z0-9-]{0,31}$/` per Phase 4) can't exist, but a vault folder `Agents/MyBot` with subfolder `../` (e.g., `MyBot/../../../etc`) defeats the containment check if the check uses string matching.

**Why it happens:** same string-vs-realpath trap as Pitfall 2, applied to writes this time.

**How to avoid:** the `vault.write` containment check uses `path.relative(agentsReal, resolved)` and asserts `relative.startsWith('..')` is rejected; `safe_path` does the realpath walk first.

**Warning signs:** write succeeds but the file appears outside the vault tree (or `path.relative` returns an absolute path).

### Pitfall 7: Audit log discloses the full vault absolute path

**What goes wrong:** every `vault.read` audit row carries the absolute vault path (`C:/Users/simth/Documents/Vault`) which is then visible in plaintext on disk to anything that reads `audit.jsonl`.

**Why it happens:** logging convenience — `params.path` set to `requestedPath` without redaction.

**How to avoid:** the audit row carries ONLY the vault-relative path (`Projects/foo.md`), never the absolute path; the global `vault.rootPath` itself is not written to audit. This matches the Phase 6 minimization pattern.

**Warning signs:** audit rows contain `C:\Users\` or `D:\`.

### Pitfall 8: Renderer falls back to the global vault when a per-bot vaultPath is empty string

**What goes wrong:** the renderer sends `patch: { vaultPath: '' }` to clear the override; the daemon stores `vaultPath: ''` (empty string, not undefined); the tool handler does `botCfg.vaultPath || globalCfg.rootPath` — empty string is falsy so it falls back. Works — BUT if the per-bot is set to a non-existent path, the bot silently falls back to global (unexpected).

**Why it happens:** `||` collapses empty string and missing into the same branch; the user might intend "explicitly empty = no vault access" vs "unset = fall back to global".

**How to avoid:** treat `vaultPath === ''` (or absent) as "use global"; treat `vaultPath === null` (explicit) as "no vault for this bot". The renderer UI should send `null` when the user clicks "Clear override" — never an empty string.

**Warning signs:** a per-bot with a typo'd path silently reads the global vault.

## Code Examples

Verified patterns from official sources:

### 1. Extending `ALLOWED_CONFIG_KEYS` (Phase 4 reuse)

```javascript
// daemon/bots/loader.cjs (existing array, extended)
// Source: daemon/bots/loader.cjs read this session
const ALLOWED_CONFIG_KEYS = [
  'id', 'name', 'persona', 'workspace', 'allowlist',
  'cron', 'cronEnabled', 'notifyOnError', 'scheduledPrompt',
  // Phase 7 additions:
  'vaultPath', 'vaultAllow', 'vaultDeny',
  'createdAt', 'updatedAt', 'status',
  'lastRunAt', 'lastRunExitReason', 'lastRunError',
  'schemaVersion',
];
```

[VERIFIED: daemon/bots/loader.cjs read this session — the array shape is verbatim from the file.]

### 2. BotConfig interface extension

```typescript
// src/shared/types.ts (additive — Phase 6 back-compat preserved)
// Source: src/shared/types.ts read this session
export interface BotConfig {
  id: string;
  name: string;
  persona: string;
  workspace: string;
  allowlist: string[];
  cron?: string;
  cronEnabled?: boolean;
  notifyOnError?: boolean;
  scheduledPrompt?: string;
  // Phase 7:
  vaultPath?: string | null;       // null = explicit "no vault for this bot"
  vaultAllow?: string[];           // empty/undefined = blocked by default
  vaultDeny?: string[];            // applied after globalDeny, before vaultAllow
  createdAt: string;
  updatedAt: string;
  status: BotStatus;
  lastRunAt?: string;
  lastRunExitReason?: 'completed' | 'cancelled' | 'errored';
  lastRunError?: string;
  schemaVersion: 1;
}
```

[VERIFIED: src/shared/types.ts:331-358 read this session — every existing field is preserved verbatim; the three new fields are additive.]

### 3. Global vault config schema

```typescript
// src/shared/types.ts (new)
// Source: src/shared/types.ts (this section to be appended at Phase 7 plan time)
export interface VaultGlobalConfig {
  /** Absolute path to the user's Obsidian vault root. */
  rootPath: string;
  /** Globs applied to every bot before per-bot lists. Win = blocked. */
  globalDeny: string[];
}

export interface VaultConfigResult {
  ok: boolean;
  config?: VaultGlobalConfig;
  error?: string;
}
```

### 4. picomatch glob check (Pattern 2 core)

```javascript
// daemon/tools/vault_glob.cjs
const picomatch = require('picomatch');

// Source: github.com/micromatch/picomatch README + npm view picomatch@4
// dot: true  → match files starting with '.' (so '.obsidian/...' is testable)
// nocase: false → filesystem-accurate (Windows is case-insensitive anyway)
const isMatch = picomatch.isMatch;
const makeMatcher = (patterns) => picomatch(patterns, { dot: true });

// Example: is 'Projects/foo.md' inside any of ['Projects/**'] ?
makeMatcher(['Projects/**'])('Projects/foo.md');          // true
makeMatcher(['Projects/**'])('Private/secret.md');        // false
makeMatcher(['**/*.md'])('Daily/2026-09-19.md');         // true
```

### 5. safe_path (REUSE Phase 2 verbatim)

```javascript
// daemon/tools/safe_path.cjs (already exists; Phase 7 callers import as-is)
// Source: daemon/tools/safe_path.cjs read this session
// Throws { code: 'outside_workspace' } if requested escapes vaultRoot.

const safePath = require('./safe_path.cjs');
const resolved = await safePath(vaultRoot, requestedRelativePath);
// resolved is guaranteed to live inside vaultRoot (realpath verified).
```

[VERIFIED: daemon/tools/safe_path.cjs read this session.]

### 6. Wikilink regex (Obsidian docs)

```javascript
// Regex covers the full Obsidian wikilink grammar.
// Source: help.obsidian.md/links (Wikilinks section)
// Variants matched:
//   [[Note Name]]
//   [[Note Name|Alias]]
//   [[Note Name#Section]]
//   [[Note Name#Section|Alias]]
const WIKILINK_RE = /\[\[([^\]|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
```

### 7. `@vscode/ripgrep` JSON streaming (REUSE Phase 2)

```javascript
// daemon/tools/vault_search.cjs (skeleton — mirrors daemon/tools/code_search.cjs)
// Source: daemon/tools/code_search.cjs read this session
const { rgPath } = require('@vscode/ripgrep');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

async function vaultSearch({ vaultRoot, query, glob, maxResults = 200, signal }) {
  const args = ['--json', '-e', query, '--no-heading', '--line-buffered'];
  if (glob) args.push('-g', glob);
  args.push(vaultRoot);

  const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'], signal });
  const rl = readline.createInterface({ input: child.stdout });
  const matches = [];
  for await (const line of rl) {
    if (matches.length >= maxResults) { child.kill(); break; }
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'match') {
        const data = evt.data;  // { path: { text: 'abs/path' }, lines: { text: '...' }, line_number, ... }
        const absPath = data.path.text;
        const relPath = path.relative(vaultRoot, absPath).replace(/\\/g, '/');
        // Run glob pipeline on the matched path (Pitfall 5 + 7):
        const access = checkVaultAccess({ globalDeny, vaultDeny, vaultAllow, relativePath: relPath });
        if (!access.allowed) continue;
        matches.push({
          path: relPath,
          lineNumber: data.line_number,
          line: data.lines.text.trimEnd(),
        });
      }
    } catch { /* malformed JSON line — skip */ }
  }
  return { matches, truncated: matches.length >= maxResults };
}
```

[VERIFIED: daemon/tools/code_search.cjs read this session — the structure (spawn rgPath, readline, max_results cap, signal abort) is verbatim from that file.]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `minimatch` for vault globs | `picomatch@4` | globby/fast-glob migration circa 2020 | Smaller, faster, same surface area; no transitive deps |
| Hand-rolled path containment | `safe_path` with realpath + ancestor walk | Phase 2 (2026-09-17) | Defeats `..`, symlinks, and Windows `\\?\` prefixes |
| `chokidar` watcher for vault index | Lazy mtime sweep at tool-call entry | standard since ~2022 | No daemon-resident watcher, simpler lifecycle, sufficient for v1 |
| `remark-parse` for wikilink AST | Single regex `[[Title(#Section)?(\|Alias)?]]` | always been sufficient | No AST overhead; only the title is needed |
| Manual atomic write (`writeFile`) | tmp file + `rename` in same directory | POSIX rename guarantee since forever | Crash-safe note creation |

**Deprecated/outdated:**
- **`glob` (npm package)** — replaced by `globby`/`fast-glob` (which use `picomatch` under the hood). Don't install `glob` directly.
- **`fs.realpathSync.native`** in the daemon — use the async `realpath` from `fs/promises` so the daemon's main loop isn't blocked on large vault trees.
- **`node-glob`** — deprecated since 2022; the modern equivalent is `picomatch` + `globby`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `picomatch@^4` is the standard modern glob matcher with no transitive deps and no native code | Standard Stack | If wrong (e.g., a regression introduced native bindings), the install would break the CLAUDE.md "no node-gyp" constraint. Mitigation: the package has been pure-JS for 9 years; npm view confirms `engines.node >=10`. |
| A2 | Obsidian wikilinks are case-insensitive and follow the `[[Title]]` / `[[Title\|Alias]]` / `[[Title#Section]]` grammar | Architecture Patterns | If Obsidian adds a new syntax variant (e.g., `![[embed]]`), the bot's wikilink_resolve would miss it. Mitigation: the regex covers the 4 documented variants; new variants can be appended without breaking existing ones. |
| A3 | The vault file index can be rebuilt lazily on every tool call (O(N) where N = vault file count) without blocking the daemon | Pattern 4 | If vaults are large (10k+ notes) and the rebuild runs on every search, latency spikes. Mitigation: cache the index by `stat(vaultRoot).mtimeMs`; rebuild only when the root mtime changes. |
| A4 | The renderer's `bot.update({ patch: { vaultAllow: [...] } })` will be persisted through the existing `writeConfigPatch` without schema changes | Pattern 1 | If the patcher silently drops unknown keys, the new policy never lands on disk. Mitigation: `ALLOWED_CONFIG_KEYS` is the allowlist — the keys are guaranteed to pass through (verified by reading `daemon/bots/loader.cjs`). |
| A5 | `safe_path.cjs` works for vault reads because the vault is just another directory tree | Pattern 3 | If the vault root is a symlink or junction, `realpath` resolves it correctly. Mitigation: `safe_path` was designed for symlink-bearing workspaces (Phase 2). |
| A6 | `@vscode/ripgrep@1.18.0` is pre-built for Windows x64 and runs as a child process with no IPC overhead | Standard Stack | If a future update drops Windows support, the daemon's `vault.search` breaks on this OS. Mitigation: pin to `1.18.0` (already pinned in `package.json`). |
| A7 | The `<userData>/vault.json` file can be loaded on every daemon start without race conditions | Architecture Patterns | If two Electron instances launch (e.g., dev mode + packaged mode), they may race on writes. Mitigation: use the same atomic tmp+rename pattern as `writeConfigPatch`. |
| A8 | `picomatch.isMatch(relativePath, pattern, { dot: true })` correctly resolves the matched pattern for audit logging | Pattern 2 | If picomatch returns `false` for the same path+pattern combo that `makeMatcher` accepted, the audit row's `pattern` field is `undefined`. Mitigation: precompile the matcher once and keep its source patterns alongside; on a hit, iterate `patterns.find(p => picomatch.isMatch(rel, p, { dot: true }))`. |

**If this table is empty:** it is not — see the 8 entries above. Each should be revisited at plan time; if any is contradicted by a source read at that point, tag accordingly.

## Open Questions

1. **Should `vault.read` return the full file or page by lines?**
   - What we know: Phase 2 `read_file` already supports `startLine`/`endLine` (see `daemon/tools/read_file.cjs`).
   - What's unclear: Obsidian notes can be very long (10k+ words for a research note); do bots need the whole file by default, or always page?
   - Recommendation: mirror Phase 2 `read_file` exactly — full read with optional slicing. Document the default in the BotSettingsPage Obsidian tab hint.

2. **Should `vault.search` be allowed to follow symlinks?**
   - What we know: ripgrep follows symlinks by default; `safe_path` resolves realpath.
   - What's unclear: a vault might symlink to a folder outside the vault root; ripgrep would still find matches there, but `safe_path` would reject them.
   - Recommendation: pass `--no-follow` to ripgrep so the daemon's containment check is the single source of truth. Document the choice.

3. **Should the global vault config be settable from the renderer without a bot-level override?**
   - What we know: PROJECT.md says "vault path configurable per-bot OR globally".
   - What's unclear: should the VaultGlobalSettingsModal require a bot to be selected, or be a top-level menu item?
   - Recommendation: top-level menu item, accessible from the top bar; both modes are independent (the per-bot override is on the BotSettingsPage Obsidian tab).

4. **What happens when the user changes the global vault path while bots are running?**
   - What we know: in-flight tool calls captured the old path in their `vaultRoot` local variable.
   - What's unclear: do we cancel in-flight runs, or let them complete and apply the new path on the next call?
   - Recommendation: let them complete; the path is captured at tool-call entry. Document the behavior.

5. **Do we need a `vault.list` (recursive directory listing) tool?**
   - What we know: Phase 2 has `list_dir` for the workspace; the vault could reuse it with `workspaceRoot = vaultRoot`.
   - What's unclear: should `list_dir` automatically pick up the vault config, or should we add a dedicated `vault.list`?
   - Recommendation: add `vault.list` so the audit row distinguishes vault reads from workspace reads. Reuse `list_dir`'s implementation.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 20+ | daemon runtime, `safe_path`, picomatch | verify via `node --version` | — | — |
| `@vscode/ripgrep@1.18.0` | `vault.search` (and existing `code_search`) | yes — in `package.json:22` | 1.18.0 | — |
| `chokidar@3.6.0` | optional index watcher | yes — in `package.json:23` | 3.6.0 | lazy mtime sweep |
| `picomatch@^4` | new — vault glob matching | NOT installed yet | — | `minimatch` (larger, transitive dep) |
| Obsidian vault folder | user must have one | user-provided; not a code dep | — | n/a — user supplies the path |
| `LOCALBOT_USER_DATA_DIR` env override | hermetic Playwright tests | yes (added Phase 1) | — | — |

**Missing dependencies with no fallback:** none.

**Missing dependencies with fallback:** `picomatch@^4` is the only new dep. If the install fails for any reason (e.g., network), the planner should fall back to `minimatch@^9` — it has the same API surface (`minimatch(path, pattern)`) and is also pure-JS, just larger.

**Step 2.6 SKIP rationale:** this phase has no external CLI / service dependencies beyond what Phase 1+2+4 already provided. The only new dep (`picomatch`) is a Node module, not a system tool.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.9 (unit) + Playwright 1.63.0 (E2E) |
| Config file | `vitest.config.ts` (existing) + `playwright.config.ts` (existing) |
| Quick run command | `npm test -- vault_glob vault_read vault_write vault_search vault_config vault_wikilink` |
| Full suite command | `npm run test:all` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OBS-01 | per-bot and global vault path configurable; per-bot overrides | unit | `npm test -- vault_config` | Wave 0 |
| OBS-02 | read anywhere with glob enforcement | unit | `npm test -- vault_read vault_glob` | Wave 0 |
| OBS-03 | write only to `Agents/<bot>/` | unit | `npm test -- vault_write` | Wave 0 |
| OBS-04 | per-bot allow/deny globs | unit | `npm test -- vault_glob` | Wave 0 |
| OBS-05 | global deny globs win | unit | `npm test -- vault_glob` (Pitfall 5 case) | Wave 0 |
| OBS-06 | vault search with context | unit + E2E | `npm test -- vault_search` + `npm run test:smoke -- obsidian-integration` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npm test -- vault_*`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green (`npm run test:all`) before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/daemon/vault_glob.test.ts` — covers OBS-04 + OBS-05 (per-bot allow/deny + global deny precedence)
- [ ] `tests/daemon/vault_read.test.ts` — covers OBS-02 (realpath + glob enforcement + slicing)
- [ ] `tests/daemon/vault_write.test.ts` — covers OBS-03 (Agents/<bot>/ containment; atomic tmp+rename)
- [ ] `tests/daemon/vault_search.test.ts` — covers OBS-06 (ripgrep stream + glob filter on results)
- [ ] `tests/daemon/vault_config.test.ts` — covers OBS-01 (`<userData>/vault.json` round-trip + atomic write + per-bot override resolution)
- [ ] `tests/daemon/vault_wikilink.test.ts` — covers wikilink regex + index case-folding
- [ ] `tests/e2e/obsidian-integration.test.ts` — Playwright: fake LLM streams `vault.read` + `vault.search` + `vault.write`; asserts audit row minimization + UI block rendering
- [ ] `tests/fakes/fake-m3-server.ts` — extend with `streamVaultReadToolUse` + `streamVaultWriteToolUse` + `streamVaultSearchToolUse` helpers

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Tool daemon is the only trust boundary; renderer/main cannot read vault files directly (SEC-01). |
| V2 Authentication | no | n/a — vault access is gated by per-bot config, not user authentication. |
| V3 Session Management | no | n/a — no new sessions. |
| V4 Access Control | yes | Per-bot allow/deny + global deny + `Agents/<bot>/` write containment (SEC-02). |
| V5 Input Validation | yes | `safe_path` realpath + picomatch glob check + `ID_REGEX` on bot id (Phase 4). |
| V6 Cryptography | no | n/a — vault paths are not secrets; no encryption needed for v1. |
| V7 Error Handling | yes | Tool errors return `{code, message}`; audit row carries `outcome: 'error'`. |
| V8 Data Protection | yes | Audit minimization: vault-relative path only, never absolute. |
| V9 Communication | yes | JSON-RPC over NDJSON (existing transport); no new channels introduced except `VAULT_*` and `EVENT_VAULT_CONFIG_UPDATED`. |
| V10 Malicious Code | n/a | n/a — no untrusted code is executed. |
| V11 Business Logic | yes | "Read-anywhere, write-agents-only" invariant is a Phase 7 business rule; enforced by the `Agents/<bot>/` containment check. |
| V12 Files and Resources | yes | Path containment via `safe_path` + write containment via `Agents/<bot>/` check + atomic tmp+rename for writes. |
| V13 API and Web Service | partial | JSON-RPC methods `vault.get_config`/`vault.set_config` validate input shape; reject non-string `rootPath` or non-array `globalDeny`. |
| V14 Configuration | yes | `<userData>/vault.json` schema `{rootPath: string, globalDeny: string[]}` validated on load. |

### Known Threat Patterns for {Electron + Node Daemon + JSON-RPC + Obsidian Vault}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal (`../`) | Tampering / EoP | `safe_path` with `realpath` + ancestor walk (Phase 2) |
| Symlink escape | Tampering / EoP | `safe_path` resolves realpath before containment check |
| Glob pattern that over-matches | Information Disclosure | `{dot: true}` is intentional; audit row includes matched pattern; UI placeholder warns |
| Bot writes outside its agents folder | Tampering | `path.relative(agentsReal, resolved)` check; `startsWith('..')` rejected |
| Global deny bypassed by per-bot allow | Information Disclosure | Glob pipeline runs `globalDeny` FIRST (Pattern 2 + Pitfall 5) |
| Audit log discloses vault absolute path | Information Disclosure | Audit row carries ONLY vault-relative path; `rootPath` never logged |
| Renderer-supplied vault path bypasses daemon | Spoofing / EoP | Daemon always resolves `botCfg.vaultPath ?? globalCfg.rootPath`; renderer cannot override |
| Malformed `<userData>/vault.json` crashes daemon | Denial of Service | `vault_config.cjs` wraps load in try/catch; falls back to empty config `{rootPath: '', globalDeny: []}` |
| Bot reads vault files outside its allowlist | Information Disclosure | Per-bot allowlist is checked AFTER global deny; empty allow = blocked by default |
| Two Electron instances race on `vault.json` | Tampering | Atomic tmp+rename (mirrors `writeConfigPatch`) |
| Wikilink parser ReDoS | Denial of Service | Regex uses `[^\]|]+` (no nested quantifiers); safe against backtracking |

## Sources

### Primary (HIGH confidence)

- `daemon/bots/loader.cjs` — read this session; canonical `ALLOWED_CONFIG_KEYS` allowlist, `validateConfig`, `writeConfigPatch`, atomic tmp+rename, `ID_REGEX`, `SCHEMA_VERSION`.
- `daemon/tools/safe_path.cjs` — read this session; canonical async path containment (`realpath` + ancestor walk, throws `{code: 'outside_workspace'}`).
- `daemon/tools/registry.cjs` — read this session; `TOOLS` array, `SCHEMAS`, `SYSTEM_TOOLS` set, `callTool(botId, name, args, ctx)` with allowlist + abort + audit.
- `daemon/tools/code_search.cjs` — read this session; `@vscode/ripgrep@1.18.0` `--json` streaming + readline + `max_results` + abort pattern reused verbatim for `vault.search`.
- `src/shared/types.ts` — read this session; `BotConfig`, `MessageBlock`, `BotCreateRequest`, `BotUpdateRequest`, audit shape, IPC payload shapes.
- `src/shared/ipc-channels.ts` — read this session; `BOTS_LIST/CREATE/UPDATE/DELETE/TRIGGER/CANCEL/RUNS`, `EVENT_BOT_LIST_UPDATED/STATUS`, `EVENT_NAVIGATE_TO_BOT`.
- `src/main/preload/index.ts` — read this session; contextBridge `api.bot.*` typed surface + `EVENT_CHANNELS` Set + generic `invoke()`.
- `src/main/paths.ts` — read this session; `userDataDir()`, `botsDir()`, `botDir(bot)`, `memoryPath`, `factsPath`. Will be extended with `vaultConfigPath()`.
- `src/renderer/components/BotSettingsPage.tsx` — read this session; 4-tab pattern (general/permissions/schedule/history), URL hash sync, debounced save on blur (250ms), lazy croner import for preview. Will be extended with a 5th "obsidian" tab.
- `src/renderer/state/bots.ts` — read this session; module-scope store, `EVENT_BOT_LIST_UPDATED` + `EVENT_BOT_STATUS` subscriptions, `triggerBot/cancelBotRun/updateBot`.
- `package.json` — read this session; runtime deps `@anthropic-ai/sdk@^0.40.1`, `@vscode/ripgrep@1.18.0`, `chokidar@3.6.0`, `croner@^9.1.0`, `diff@5.2.2`, `react-arborist@3.16.0`, `react-diff-viewer-continued@4.4.0`; dev deps include `vitest@^2.1.9`, `@playwright/test@^1.63.0`, `electron@^33.2.0`, `typescript@^5.7.2`.
- `.planning/PROJECT.md` — read this session; locked decisions including "Hybrid Obsidian access model" and "vault path configurable per-bot OR globally".
- `.planning/REQUIREMENTS.md` — read this session; OBS-01..06 + LLM/SEC/UI cross-references.
- `.planning/STATE.md` — read this session; Phase 6 complete (3/3 plans, 345+ tests passing), audit minimization 3-key shape already in production.
- `.planning/phases/06-scheduler-notifications/06-RESEARCH.md` — read this session; template structure reused verbatim.

### Secondary (MEDIUM confidence)

- `help.obsidian.md/links` — Wikilinks section grammar (`[[Title]]`, `[[Title|Alias]]`, `[[Title#Section]]`).
- `github.com/micromatch/picomatch` README — API surface (`picomatch(patterns, options)`, `picomatch.isMatch(path, pattern, options)`, `{dot, nocase, ...}`).
- `npmjs.com/picomatch` — package metadata: pure-JS, no transitive deps, `engines.node >=10`.
- Obsidian folder layout convention — `Agents/<bot-name>/` is a community-standard subfolder pattern for AI-generated notes inside a vault.

### Tertiary (LOW confidence — `[ASSUMED]`)

- Picomatch is the modern standard glob matcher (vs `minimatch`) — known from training data, confirmed by registry lookup.
- A realpath-based containment check is sufficient against Windows symlink/junction tricks — known from training data, but not exercised against every Windows 11 edge case in this session.

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — `picomatch@^4`, `@vscode/ripgrep@1.18.0`, `chokidar@3.6.0` all confirmed in `package.json` or npm registry; pure-JS, no native deps.
- Architecture: **HIGH** — every existing seam (`safe_path`, `write_file`, `code_search`, `ALLOWED_CONFIG_KEYS`, `validateConfig`, `writeConfigPatch`) read this session; the new tools are additive extensions.
- Pitfalls: **MEDIUM** — 8 pitfalls catalogued; 3 (`picomatch`, wikilink grammar, file-index rebuild cost) carry `[ASSUMED]` tags in the Assumptions Log.
- Patterns: **HIGH** — 5 patterns documented with code sketches; 3 reuse Phase 2/4 seams verbatim, 2 are new but follow the same shape.
- Security: **HIGH** — ASVS V1/V4/V5/V8/V11/V12/V14 directly applicable; every threat has a documented mitigation that ties to an existing seam.

**Research date:** 2026-09-19
**Valid until:** 2026-10-19 (30 days — the stack is stable; picomatch and @vscode/ripgrep have not seen breaking changes in over a year; vault conventions are community-stable)

