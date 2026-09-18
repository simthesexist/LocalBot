// Daemon memory update. Phase 3 tracer slice.
//
// LLM-callable tool: appends or replaces a `## <section>` block in memory.md.
// Loaded via registry.callTool(bot, 'memory.update', ...) and gated by the
// default bot's allowlist. The system bypass (memory.read / memory.write /
// tree.list) does NOT go through this tool.

const fs = require('node:fs/promises');
const { safePath } = require('./safe_path.cjs');

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function call(args, ctx) {
  if (!ctx || !ctx.botDir) throw err('invalid_ctx', 'botDir not provided');
  if (!args || typeof args.section !== 'string' || args.section.length === 0) {
    throw err('invalid_args', 'section is required');
  }
  if (typeof args.content !== 'string') {
    throw err('invalid_args', 'content is required');
  }

  const mdSafe = await safePath(ctx.botDir, 'memory.md');
  let existing = '';
  try {
    existing = await fs.readFile(mdSafe, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Replace existing `## <section>` block, or append at the end.
  const heading = `## ${args.section}`;
  const lines = existing.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  let next;
  if (startIdx >= 0) {
    // Find end of section: next `## ` heading or end of file.
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    next = [
      ...lines.slice(0, startIdx),
      heading,
      args.content,
      '',
      ...lines.slice(endIdx),
    ].join('\n');
  } else {
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    next = `${existing}${sep}${heading}\n${args.content}\n`;
  }

  // Cap at 8 KB to avoid runaway memory growth (Pitfall 1).
  const bytes = Buffer.byteLength(next, 'utf8');
  if (bytes > 8192) {
    throw err('too_large', `memory.md would be ${bytes}B; exceeds 8 KB cap. Consolidate older sections.`);
  }

  // Atomic write via tmp + rename (same pattern as memory_write).
  const path = require('node:path');
  const crypto = require('node:crypto');
  const tmpName = `.memory.md.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(ctx.botDir, tmpName);
  try {
    await fs.writeFile(tmpPath, next, 'utf8');
    await fs.rename(tmpPath, mdSafe);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }

  return {
    path: mdSafe,
    bytesWritten: bytes,
    section: args.section,
  };
}

module.exports = { call };