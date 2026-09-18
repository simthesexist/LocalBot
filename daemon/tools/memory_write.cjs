// Daemon memory write. Phase 3 tracer slice.
// Atomic tmp+rename for memory.md + facts.json. Per-bot JS mutex serializes
// concurrent writes so two simultaneous updates don't race the tmp files.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { safePath } = require('./safe_path.cjs');

// Per-bot mutex chain. Keyed by the request's `bot` arg (the bot whose
// memory is being mutated), not by ctx.botDir (which may be missing).
const writeMutex = new Map();

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function atomicWriteFile(absPath, content) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  // Use a randomized tmp name to avoid collisions between concurrent writes
  // for different files in the same dir. The rename below is atomic on
  // Windows since Node 14 (see docs for fs.rename).
  const tmpName = `.${path.basename(absPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, absPath);
  } catch (e) {
    // Best-effort cleanup of orphaned tmp files.
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

function validateFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw err('invalid_facts_schema', 'facts must be a plain object');
  }
  for (const [name, entry] of Object.entries(facts)) {
    if (!entry || typeof entry !== 'object') {
      throw err('invalid_facts_schema', `fact '${name}' must be an object`);
    }
    if (!('value' in entry)) {
      throw err('invalid_facts_schema', `fact '${name}' missing 'value'`);
    }
    // source + updatedAt are optional on write; the daemon stores whatever
    // the caller passes (merge happens in main, not here).
  }
}

async function call(args, ctx) {
  if (!ctx || !ctx.botDir) {
    throw err('invalid_ctx', 'botDir not provided');
  }
  if (!args || typeof args.markdown !== 'string') {
    throw err('invalid_args', 'markdown must be a string');
  }
  if (args.facts !== undefined && args.facts !== null) {
    try {
      validateFacts(args.facts);
    } catch (e) {
      throw e;
    }
  }

  const botKey = (args && typeof args.bot === 'string' && args.bot.length > 0)
    ? args.bot
    : '_system';

  // Per-bot mutex chain. Queue a continuation that runs only after the prior
  // write (if any) settles.
  const prev = writeMutex.get(botKey) ?? Promise.resolve();
  let release;
  const myTurn = new Promise((res) => { release = res; });
  writeMutex.set(
    botKey,
    prev.then(() => myTurn),
  );

  await prev;
  try {
    const mdSafe = await safePath(ctx.botDir, 'memory.md');
    const factsSafe = await safePath(ctx.botDir, 'facts.json');

    const bytesWritten = Buffer.byteLength(args.markdown, 'utf8');
    if (bytesWritten > 8192) {
      throw err('too_large', `memory.md ${bytesWritten}B exceeds 8KB hard cap`);
    }

    await atomicWriteFile(mdSafe, args.markdown);

    let factCount = 0;
    if (args.facts !== undefined && args.facts !== null) {
      const factsJson = JSON.stringify(args.facts, null, 2);
      await atomicWriteFile(factsSafe, factsJson);
      factCount = Object.keys(args.facts).length;
    }

    return {
      path: mdSafe,
      bytesWritten,
      factCount,
    };
  } finally {
    release();
    // If we are the last in the chain, drop the entry so the map doesn't grow.
    writeMutex.get(botKey).then((v) => {
      if (v === myTurn) writeMutex.delete(botKey);
    }).catch(() => { /* ignore */ });
  }
}

module.exports = { call };