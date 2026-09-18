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
};

function getPolicy(_botId) {
  // Phase 2: hardcoded default. Phase 4: load <userData>/bots/<botId>.json.
  // For Phase 2 we always return the default policy — Phase 1 daemon has no
  // per-bot file yet, and the orchestrator currently uses one bot ('default').
  return DEFAULT_POLICY;
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
  const policy = getPolicy(botId);
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