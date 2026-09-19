// Tool registry. Phase 2 Wave 1:
//   - allowlist + denylist enforced BEFORE any fs call (SEC-02)
//   - tool schemas returned from tools/list so main forwards them to M3
//   - cancelToolCall tracks in-flight tool children and kills ripgrep on
//     cancel (Wave 3).
//
// Phase 3 Wave 1: extend with memory.read / memory.write / memory.update /
// tree.list. The first three live in `TOOLS` for LLM-callable surface (only
// `memory.update` is in the default bot allowlist). tree.list is exposed via
// the registry so the SYSTEM bypass (main's callTree) can dispatch through
// the same path; LLM-callable trees are NOT in the default allowlist.

const { DEFAULT_POLICY } = require('../bots/default.cjs');

const TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'code_search',
  'memory.read',
  'memory.write',
  'memory.update',
  'tree.list',
  // Phase 5 Wave 1: shell execution. NOT in DEFAULT_POLICY.allowlist (opt-in
  // per bot via config.json#allowlist).
  'exec_command',
  // Phase 7 Plan 1: Obsidian vault access (read + write). vault.search +
  // vault.list land in Plan 07-02. NOT in DEFAULT_POLICY.allowlist — each
  // bot opts in via its own `vaultAllow` glob list.
  'vault.read',
  'vault.write',
  // Phase 7 Plan 2: ripgrep-based vault search + readdir-based vault list.
  // Both subject to the same deny-wins glob pipeline as vault.read.
  'vault.search',
  'vault.list',
  // Phase 8 Plan 1: browser.navigate — Playwright-backed headless Chromium
  // navigation. Subject to per-bot URL allowlist (browserAllow) +
  // denylist (browserDeny) + SSRF shield (RFC1918/127/169.254/IPv6
  // link-local/ULA/loopback unless ssrfAllowInternal). NOT in
  // DEFAULT_POLICY.allowlist — per-bot opt-in via BotSettingsBrowserTab
  // (per RESEARCH §Architectural Responsibility Map).
  'browser.navigate',
  // Phase 8 Plan 2: the 5 remaining browser tools — all share the same
  // URL allowlist + SSRF shield as browser.navigate. Each runs
  // checkBrowserUrl on `page.url()` BEFORE any Playwright action
  // (Pitfall: page state may have changed). NOT in DEFAULT_POLICY —
  // per-bot opt-in.
  'browser.click',
  'browser.type',
  'browser.screenshot',
  'browser.evaluate',
  'browser.fill_form',
];

// Tools that bypass the per-bot allowlist when called from main. The
// `tools/call` path in main.cjs explicitly sets `bot='_system'` for these
// (see SYSTEM_TOOLS below), and the registry short-circuits the allowlist
// check for them so the daemon's own bootstrap code can read/write memory
// without polluting the bot policy.
const SYSTEM_TOOLS = new Set(['memory.read', 'memory.write', 'tree.list']);

const SCHEMAS = {
  read_file: {
    name: 'read_file',
    description: 'Read the UTF-8 text contents of a file inside the bot workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to workspace, or absolute inside workspace.',
        },
      },
      required: ['path'],
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Write content to a file inside the workspace. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace, or absolute inside workspace.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    name: 'edit_file',
    description: 'Apply a single find/replace edit to an existing file. Refuses if match count != 1.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace, or absolute inside workspace.' },
        find: { type: 'string', description: 'Exact substring to find. Must match exactly once.' },
        replace: { type: 'string', description: 'Replacement substring.' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  list_dir: {
    name: 'list_dir',
    description: 'List entries in a directory inside the workspace. Dirs first, then alphabetical.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path inside workspace. Use "." for the workspace root.',
        },
      },
      required: ['path'],
    },
  },
  code_search: {
    name: 'code_search',
    description: 'ripgrep-based code search across the workspace. Supports regex + glob.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ripgrep regex pattern.' },
        glob: { type: 'string', description: 'Optional ripgrep --glob filter (e.g. "*.ts").' },
        path: { type: 'string', description: 'Search root inside workspace. Defaults to ".".' },
        max_results: { type: 'number', description: 'Cap matches returned (default 200).' },
      },
      required: ['pattern'],
    },
  },
  'memory.read': {
    name: 'memory.read',
    description: 'Read the bot\'s persistent memory (memory.md + facts.json).',
    input_schema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id whose memory should be returned.' },
      },
      required: ['bot'],
    },
  },
  'memory.write': {
    name: 'memory.write',
    description: 'Replace the bot\'s memory.md + facts.json (system call; not in default bot allowlist).',
    input_schema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id whose memory should be replaced.' },
        markdown: { type: 'string', description: 'Full markdown contents of memory.md (<= 8 KB).' },
        facts: { type: 'object', description: 'Key-value facts object; values are {value, source?, updatedAt?}.', additionalProperties: true },
      },
      required: ['bot', 'markdown'],
    },
  },
  'memory.update': {
    name: 'memory.update',
    description: 'Append or replace a section of memory.md; optionally update facts. LLM-callable.',
    input_schema: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: 'Bot id whose memory is being updated.' },
        section: { type: 'string', description: 'H2 section name (e.g. "Identity", "Preferences").' },
        content: { type: 'string', description: 'Section content (markdown).' },
      },
      required: ['bot', 'section', 'content'],
    },
  },
  'tree.list': {
    name: 'tree.list',
    description: 'Recursive workspace tree. Caps per-dir entries + depth; skips node_modules/.git.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path inside workspace. Defaults to ".".' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth (default 5).' },
        maxEntriesPerDir: { type: 'number', description: 'Cap entries per dir (default 500).' },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Names to skip (overrides default).' },
      },
    },
  },
  exec_command: {
    name: 'exec_command',
    description: 'Run a shell command. Subject to the global denylist + per-bot allowlist + per-bot always-allow + approval gate. Returns exitCode, stdoutBytes, stderrCount.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run (cmd.exe on Windows, /bin/sh on POSIX).' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the daemon cwd.' },
        timeoutMs: { type: 'integer', description: 'Hard timeout in ms (kills the child if exceeded).' },
      },
      required: ['command'],
    },
  },
  // Phase 7 Plan 1: vault.read — read a note from the Obsidian vault. The
  // path is vault-relative (e.g. "Projects/foo.md") or absolute inside
  // vaultRoot. The daemon runs safe_path realpath + the deny-wins glob
  // pipeline before any fs call.
  'vault.read': {
    name: 'vault.read',
    description: 'Read a note from the Obsidian vault (subject to per-bot vaultAllow/vaultDeny + globalDeny enforcement).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path (e.g. "Projects/foo.md") or absolute path inside vault.' },
        startLine: { type: 'integer', description: '1-based start line (inclusive) for slicing.' },
        endLine: { type: 'integer', description: 'End line (inclusive) for slicing.' },
      },
      required: ['path'],
    },
  },
  // Phase 7 Plan 1: vault.write — write a note to Agents/<bot>/ of the
  // vault. Refuses any other path with code:'write_outside_agents' (after
  // the safe_path realpath check). Atomic tmp + rename write.
  'vault.write': {
    name: 'vault.write',
    description: 'Write a note to Agents/<bot>/ of the vault. Refuses any other path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path under Agents/<bot>/ (e.g. "Agents/alpha/note.md") or absolute path inside vault.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
  },
  // Phase 7 Plan 2: vault.search — ripgrep-based search across the vault.
  // Each match is filtered through the deny-wins glob pipeline
  // (globalDeny → vaultDeny → vaultAllow) before reaching the renderer
  // (T-7-10). --no-follow is applied to ripgrep so symlinks outside the
  // vault cannot leak matches (Pitfall Open Question #2).
  'vault.search': {
    name: 'vault.search',
    description: 'ripgrep-based search across the vault. Returns matching lines with file path + line number + text. Subject to per-bot + global glob enforcement.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ripgrep regex pattern.' },
        glob: { type: 'string', description: 'Optional ripgrep --glob filter (e.g. "*.md").' },
        max_results: { type: 'number', description: 'Cap matches returned (default 200, max 1000).' },
      },
      required: ['pattern'],
    },
  },
  // Phase 7 Plan 2: vault.list — list entries in a vault directory. The
  // listed dir's vault-relative path is filtered through the glob
  // pipeline BEFORE returning entries (Plan 07-02 prohibition #4).
  // Dirs first, then alphabetical. Hidden dirs (.obsidian, .trash)
  // skipped unless includeHidden is true.
  'vault.list': {
    name: 'vault.list',
    description: 'List entries in a vault directory. Sorted dirs-first then alphabetical. Subject to glob enforcement.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path inside vault. Defaults to ".".' },
        includeHidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
      },
    },
  },
  // Phase 8 Plan 1: browser.navigate — headless Chromium navigation
  // through Playwright. Scheme allowlist (http + https only) +
  // DNS-resolved SSRF shield + per-bot URL allowlist/denylist. The 5
  // remaining browser tools (click/type/fill_form/screenshot/evaluate)
  // land in Plan 2.
  'browser.navigate': {
    name: 'browser.navigate',
    description: 'Navigate to a URL in headless Chromium. Subject to URL allowlist + SSRF shield (default-deny when browserAllow is empty).',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to navigate to. Scheme allowlist: http + https only.',
        },
      },
      required: ['url'],
    },
  },
  // Phase 8 Plan 2: browser.click — click a CSS selector on the CURRENT
  // page. The URL allowlist check runs against `page.url()` (page state
  // may have changed since the last navigate). 10s page.click timeout;
  // Playwright timeout surfaces as {code:'selector_not_found'}.
  'browser.click': {
    name: 'browser.click',
    description: 'Click a DOM element by CSS selector on the current page. Subject to URL allowlist + SSRF shield.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to click.',
        },
      },
      required: ['selector'],
    },
  },
  // Phase 8 Plan 2: browser.type — fill an input by CSS selector via
  // page.locator(selector).fill(text). Optional `submit:true` presses
  // Enter after fill. Audit NEVER includes the typed text (Pitfall 5).
  'browser.type': {
    name: 'browser.type',
    description: 'Fill an input element by CSS selector. Subject to URL allowlist. Audit carries textBytes only, never the typed text.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element.',
        },
        text: {
          type: 'string',
          description: 'Text to fill into the input.',
        },
        submit: {
          type: 'boolean',
          description: 'If true, press Enter after filling (default false).',
        },
      },
      required: ['selector', 'text'],
    },
  },
  // Phase 8 Plan 2: browser.screenshot — capture a PNG of the current
  // viewport (or full page when fullPage:true). Writes atomically to
  // <userData>/screenshots/<runId>/<n>.png. 50 PNGs per runId + 500MB
  // total disk quota (Pitfall 6). `n` must match /^[a-zA-Z0-9._-]{1,32}$/.
  'browser.screenshot': {
    name: 'browser.screenshot',
    description: 'Capture a PNG of the current viewport. Subject to URL allowlist + 50/runId + 500MB total disk quota.',
    input_schema: {
      type: 'object',
      properties: {
        n: {
          type: 'string',
          description: 'Filename slug (default: timestamp base36). Must match /^[a-zA-Z0-9._-]{1,32}$/.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of the viewport (default false).',
        },
      },
    },
  },
  // Phase 8 Plan 2: browser.evaluate — execute JavaScript in the page
  // context. 10s timeout + 50KB result cap. Audit NEVER includes the
  // expression source or the result value (Pitfall 5).
  'browser.evaluate': {
    name: 'browser.evaluate',
    description: 'Execute JavaScript in the page context. 10s timeout + 50KB result cap. Subject to URL allowlist. Audit carries expressionBytes only.',
    input_schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate. Up to 100KB.',
        },
      },
      required: ['expression'],
    },
  },
  // Phase 8 Plan 2: browser.fill_form — fill multiple form fields in a
  // single tool call. Promise.all parallel fills (NOT sequential).
  // Optional `submit: {selector}` clicks a final button after all fills
  // complete. Up to 20 fields per call. Audit NEVER includes field values.
  'browser.fill_form': {
    name: 'browser.fill_form',
    description: 'Fill multiple form fields in a single call (parallel). Subject to URL allowlist. Up to 20 fields per call.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
          description: 'Array of {selector, value} pairs to fill in parallel.',
        },
        submit: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
          },
          description: 'Optional button selector to click after all fills complete.',
        },
      },
      required: ['fields'],
    },
  },
};

// Phase 4: getPolicy delegates to bots/policy.cjs#getPolicy(botId, ctx) which
// reads <userData>/bots/<botId>/config.json#allowlist on every call (no cache,
// per T-P4-03 / RESEARCH.md Pitfall 1). Falls back to DEFAULT_POLICY for the
// implicit `default` bot (Phase 3 back-compat) and for `_system` calls.
const botPolicy = require('../bots/policy.cjs');
function getPolicy(botId, ctx) {
  return botPolicy.getPolicy(botId, ctx || {});
}

function listTools() {
  return TOOLS.map((name) => SCHEMAS[name]);
}

const loaded = new Map();
// Explicit file map. Most tools follow the `<dotted_name_with_underscores>` rule,
// but `tree.list` predates that convention and lives at `list_tree.cjs`.
const TOOL_FILE = {
  'tree.list': 'list_tree.cjs',
};
function fileFor(name) {
  return TOOL_FILE[name] ?? name.replace(/\./g, '_') + '.cjs';
}
function loadTool(name) {
  if (loaded.has(name)) return loaded.get(name);
  const mod = require(`./${fileFor(name)}`);
  loaded.set(name, mod);
  return mod;
}

// Wave 3: in-flight tool child tracking so `tools/cancel` can kill long-
// running subprocesses (currently only `code_search`/`rg`). toolCallId is the
// JSON-RPC `params.toolCallId` from the `tools/call` request.
const activeChildren = new Map();

function registerChild(toolCallId, child) {
  if (!toolCallId || !child) return;
  activeChildren.set(toolCallId, child);
  // Auto-clean when the child exits so the map doesn't grow unbounded.
  child.once('exit', () => {
    if (activeChildren.get(toolCallId) === child) {
      activeChildren.delete(toolCallId);
    }
  });
}

function unregisterChild(toolCallId) {
  if (!toolCallId) return;
  activeChildren.delete(toolCallId);
}

function cancelToolCall(toolCallId) {
  if (!toolCallId) return { cancelled: false, reason: 'not_found' };
  const child = activeChildren.get(toolCallId);
  if (!child) return { cancelled: false, reason: 'not_found' };
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore — process may have just exited */
  }
  // Hard fallback: SIGKILL after 2s if the child didn't honor SIGTERM.
  setTimeout(() => {
    if (activeChildren.get(toolCallId) === child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 2000);
  return { cancelled: true };
}

async function callTool(botId, name, args, ctx) {
  // Line 1: denylist check (highest priority — overrides allowlist).
  // Phase 4: thread ctx so the per-bot allowlist loader can read
  // <userData>/bots/<bot>/config.json on every call (T-P4-03: no caching).
  const policy = getPolicy(botId, ctx);
  if (policy.denylist.has(name)) {
    const e = new Error(`tool '${name}' denied by denylist`);
    e.code = 'denied';
    e.reason = 'denylist';
    throw e;
  }
  // Line 2: known-tool guard (typos + bypass attempts). Runs BEFORE allowlist
  // so the error code is informative — `unknown_tool` for an unregistered name
  // is more useful than a blanket `denied:allowlist`.
  if (!TOOLS.includes(name)) {
    const e = new Error(`unknown tool: ${name}`);
    e.code = 'unknown_tool';
    throw e;
  }
  // Line 3: allowlist check (BEFORE any require() of the tool module).
  // SYSTEM_TOOLS bypass the allowlist (called from main directly with bot='_system').
  const isSystem = SYSTEM_TOOLS.has(name) && (botId === '_system' || botId === undefined);
  if (!isSystem && !policy.allowlist.has(name)) {
    const e = new Error(`tool '${name}' not in bot allowlist`);
    e.code = 'denied';
    e.reason = 'allowlist';
    throw e;
  }
  // Line 4: dispatch. We thread `registry` + `registerChild` / `unregisterChild`
  // so tools that spawn long-lived children (code_search → rg) can register
  // themselves for cancellation by toolCallId.
  const mod = loadTool(name);
  return await mod.call(args, {
    ...ctx,
    registry: {
      registerChild,
      unregisterChild,
      activeChildren, // exposed so future tools / tests can introspect
    },
  });
}

module.exports = {
  listTools,
  callTool,
  cancelToolCall,
  registerChild,
  unregisterChild,
  activeChildren, // exposed for tests
  TOOLS,
  SCHEMAS,
  SYSTEM_TOOLS,
  // Exported for unit tests.
  __test__: { getPolicy, loadTool },
};