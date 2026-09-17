// NDJSON framing for the daemon side.

const MAX_LINE_BYTES = 1024 * 1024;

function writeMessage(stream, obj) {
  const line = JSON.stringify(obj) + '\n';
  stream.write(line);
}

function readMessage(line) {
  if (!line || line.length > MAX_LINE_BYTES) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { writeMessage, readMessage, MAX_LINE_BYTES };
