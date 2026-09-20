/**
 * Minimal MCP stdio transport: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *
 * Implemented directly rather than pulled in, to hold the plugin's zero-dependency
 * line. Only what a tool server needs is here: initialize, tools/list, tools/call,
 * ping, and notification handling.
 *
 * stdout belongs to the protocol. Everything diagnostic goes to stderr.
 */
const PROTOCOL_VERSION = '2025-06-18';

export function createServer({ name, version, tools, onError }) {
  const handlers = new Map();
  let closed = false;

  const write = (message) => {
    if (closed) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) =>
    write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  handlers.set('initialize', (id) => {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name, version },
    });
  });

  handlers.set('ping', (id) => reply(id, {}));

  handlers.set('tools/list', (id) => {
    reply(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    });
  });

  handlers.set('tools/call', async (id, params) => {
    const tool = tools.find((candidate) => candidate.name === params?.name);
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.handler(params.arguments ?? {});
      reply(id, {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        ...(typeof result === 'object' && result !== null ? { structuredContent: result } : {}),
      });
    } catch (error) {
      onError?.(error);
      // A tool error is reported as tool output, not a protocol error, so the
      // model can read it and react instead of the call simply vanishing.
      reply(id, {
        isError: true,
        content: [{ type: 'text', text: `delegation failed: ${error.message}` }],
      });
    }
  });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a malformed frame is dropped; there is no id to answer
      }
      const handler = handlers.get(message.method);
      if (message.id === undefined) continue; // notification: nothing to answer
      if (!handler) {
        fail(message.id, -32601, `method not found: ${message.method}`);
        continue;
      }
      Promise.resolve(handler(message.id, message.params)).catch((error) => {
        onError?.(error);
        fail(message.id, -32603, error.message);
      });
    }
  });

  process.stdin.on('end', () => { closed = true; });
  return { close: () => { closed = true; } };
}
