// Daemon memory read. Phase 3 tracer slice.
// Reads <botDir>/memory.md + <botDir>/facts.json via the safePath containment
// helper. Returns empty defaults on ENOENT; surfaces parseError for malformed
// facts.json without throwing (the renderer shows a friendly warning).

const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./safe_path.cjs');

async function call(args, ctx) {
  if (!ctx || !ctx.botDir) {
    const e = new Error('botDir not provided');
    e.code = 'invalid_ctx';
    throw e;
  }

  const mdPath = await safePath(ctx.botDir, 'memory.md');
  const factsPath = await safePath(ctx.botDir, 'facts.json');

  let markdown = '';
  let bytes = 0;
  let updatedAt = new Date(0).toISOString();
  try {
    const stat = await fs.stat(mdPath);
    markdown = await fs.readFile(mdPath, 'utf8');
    bytes = Buffer.byteLength(markdown, 'utf8');
    updatedAt = stat.mtime.toISOString();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let facts = {};
  let parseError;
  try {
    const raw = await fs.readFile(factsPath, 'utf8');
    facts = JSON.parse(raw);
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
      facts = {};
      parseError = 'facts.json root was not an object';
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      facts = {};
    } else if (err instanceof SyntaxError) {
      facts = {};
      parseError = err.message;
    } else {
      throw err;
    }
  }

  return {
    markdown,
    facts,
    bytes,
    factCount: Object.keys(facts).length,
    updatedAt,
    ...(parseError ? { parseError } : {}),
  };
}

module.exports = { call };