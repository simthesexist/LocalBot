// Daemon-side audit writer. The daemon writes to the SAME daily JSONL file as main,
// under <userData>/audit/YYYY-MM-DD.jsonl.

const fs = require('node:fs');
const path = require('node:path');

let userDataDir = null;
let cachedStream = null;

function setUserDataDir(dir) {
  userDataDir = dir;
  cachedStream = null;
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
  const record = { ts: new Date().toISOString(), bot: 'daemon', ...line };
  const stream = getStream(date);
  stream.write(JSON.stringify(record) + '\n');
}

process.on('exit', () => {
  if (cachedStream) {
    try { cachedStream.stream.end(); } catch {}
  }
});

module.exports = { appendAudit, setUserDataDir };
