// Default bot policy for Phase 2. Phase 4 will replace this with a per-bot
// loader that reads <userData>/bots/<botId>.json.
//
// Phase 3 Wave 1: extend allowlist with `memory.update` (LLM-callable). The
// system calls (memory.read / memory.write / tree.list) bypass the allowlist
// via SYSTEM_TOOLS in registry.cjs and do not appear here.

const DEFAULT_POLICY = {
  allowlist: new Set([
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'code_search',
    'memory.update',
  ]),
  denylist: new Set(),
};

module.exports = { DEFAULT_POLICY };