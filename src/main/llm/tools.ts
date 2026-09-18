// Tool schemas forwarded to M3 in `client.messages.stream({ tools })`.
//
// Phase 2 keeps the schemas duplicated between main (this file) and
// daemon/tools/registry.cjs (the source of truth). The duplication is small
// (5 tools) and the lockstep is enforced by the registry unit test. A future
// plan can replace this with a startup read of `tools/list` from the daemon.

import type Anthropic from '@anthropic-ai/sdk';

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
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
  {
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
  {
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
  {
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
  {
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
  // Phase 3: bot-self memory tool. Called by the LLM when it wants to
  // remember something for later (Pitfall 6). Kept consistent with the
  // daemon's memory.update schema in registry.cjs.
  {
    name: 'memory.update',
    description: "Append or replace a `## <section>` block in the bot's memory.md.",
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Heading text of the section (without the leading ## ).' },
        body: { type: 'string', description: 'Markdown body for the section.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'How to merge the body (default: replace).' },
      },
      required: ['section', 'body'],
    },
  },
];
