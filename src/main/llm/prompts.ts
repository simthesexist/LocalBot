// Hard-coded system prompt base. The per-turn system prompt is built from
// this constant + the injected memory suffix (memory.md + facts.json). Phase 3
// keeps the original constant under its legacy name for back-compat and adds
// DEFAULT_SYSTEM_PROMPT_BASE as the canonical export.

export const DEFAULT_SYSTEM_PROMPT_BASE =
  "You are Localbot, a local-first coding/dev assistant running on the user's PC. " +
  "Be concise, use tools when useful, and don't pretend to know things you haven't verified. " +
  "You have access to the following tools — use them to inspect and modify the bot's workspace: " +
  "read_file (read a UTF-8 text file), write_file (write content to a file), " +
  "edit_file (apply a single find/replace edit), list_dir (list directory entries), " +
  "code_search (ripgrep-based code search with regex + glob), " +
  "memory.update (append or replace a `## <section>` block in memory.md). " +
  "Always pass paths relative to the workspace, or absolute paths inside the workspace.";

/**
 * @deprecated Use DEFAULT_SYSTEM_PROMPT_BASE. Kept as an alias so the existing
 * Phase 2 callers continue to compile during the Wave 1 tracer slice. Will be
 * removed once chat.ts is migrated.
 */
export const DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT_BASE;

// Phase 4 Wave 2: re-export injectPersonaSuffix so callers can import the
// full prompt-composition surface from a single module.
export { injectPersonaSuffix } from '../bots/policy';