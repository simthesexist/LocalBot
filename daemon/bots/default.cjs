// Default bot policy for Phase 2. Phase 4 will replace this with a per-bot
// loader that reads <userData>/bots/<botId>.json.

const DEFAULT_POLICY = {
  allowlist: new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'code_search']),
  denylist: new Set(),
};

module.exports = { DEFAULT_POLICY };
