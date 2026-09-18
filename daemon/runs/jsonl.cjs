// Phase 4 Wave 2: daemon-side per-bot run history NDJSON writer.
//
// Atomic append-only JSONL at <userDataDir>/runs/<bot>.jsonl. Per-bot
// mutex via Map<bot, Promise> chain serializes concurrent writes
// (matches Phase 3's memory_write pattern). The reader returns rows in
// reverse-insertion order so the most recent run is first.

const fs = require('node:fs');
const path = require('node:path');

const writeMutex = new Map();

function appendRun(userDataDir, bot, record) {
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    return Promise.reject(new Error('userDataDir required'));
  }
  if (typeof bot !== 'string' || bot.length === 0) {
    return Promise.reject(new Error('bot required'));
  }
  const dir = path.join(userDataDir, 'runs', bot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bot.jsonl');
  const line = JSON.stringify(record) + '\n';
  const prev = writeMutex.get(bot) || Promise.resolve();
  const next = prev.then(() => new Promise((resolve, reject) => {
    fs.appendFile(file, line, 'utf8', (err) => err ? reject(err) : resolve());
  }));
  writeMutex.set(bot, next);
  // Swallow errors on the chain so one failure doesn't poison the next call.
  next.catch(() => { /* keep chain alive */ });
  return next;
}

function listRuns(userDataDir, bot, limit) {
  return new Promise((resolve) => {
    const dir = path.join(userDataDir, 'runs', bot);
    const file = path.join(dir, 'bot.jsonl');
    fs.readFile(file, 'utf8', (err, text) => {
      if (err) {
        if (err.code === 'ENOENT') return resolve([]);
        return resolve([]);
      }
      const cap = typeof limit === 'number' && limit > 0 ? limit : 50;
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      const out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch { /* skip malformed */ }
      }
      resolve(out);
    });
  });
}

module.exports = { appendRun, listRuns };
