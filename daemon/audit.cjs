// Daemon-side audit writer. The daemon writes to the SAME daily JSONL file as main,
// under <userData>/audit/YYYY-MM-DD.jsonl.

const fs = require('node:fs');
const path = require('node:path');

let userDataDir = null;
let cachedStream = null;
let currentBotId = null;

function setUserDataDir(dir) {
  userDataDir = dir;
  cachedStream = null;
}

function setCurrentBot(botId) {
  currentBotId = botId;
}

function utcDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getStream(date) {
  if (cachedStream && cachedStream.date === date) return cachedStream.stream;
  if (cachedStream) {
    try { cachedStream.stream.end(); } catch {}
    cachedStream = null;
  }
  const dir = path.join(userDataDir || '', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
  cachedStream = { date, stream };
  return stream;
}

function appendAudit(line) {
  if (!userDataDir) return;
  const date = utcDateString();
  // Resolve bot priority: explicit line.bot > initialize state.bot > 'default' fallback.
  // The 'daemon' constant is REMOVED — every audit line must carry the actual bot id.
  const botId = (line && typeof line.bot === 'string' && line.bot.length > 0)
    ? line.bot
    : (currentBotId || 'default');
  const record = { ts: new Date().toISOString(), bot: botId, ...line };
  const stream = getStream(date);
  stream.write(JSON.stringify(record) + '\n');
}

process.on('exit', () => {
  if (cachedStream) {
    try { cachedStream.stream.end(); } catch {}
  }
});

module.exports = { appendAudit, setUserDataDir, setCurrentBot };
