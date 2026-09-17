// Tool registry. Phase 1 stub: every tool call returns unknown_tool.

function listTools() {
  return [];
}

async function callTool(name, _args) {
  // D-11: stub error so dispatch + audit hooks are exercised end-to-end.
  const err = new Error('no tools registered (Phase 1 stub)');
  err.code = 'unknown_tool';
  throw err;
}

module.exports = { listTools, callTool };
