import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

/**
 * The delegation boundary is the whole design, so it is tested through the real
 * MCP transport: whatever the main session can see is whatever this server says.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mcpExchange(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-sqlite', path.join(root, 'src/mcp/server.mjs')], {
      env: { ...process.env, JEV_DISPATCH_DB_PATH: path.join(tempDir(), 'mcp.db'), JEV_DISPATCH_LOG_LEVEL: 'error', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('mcp server timed out')); }, 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.trim().split('\n').length >= requests.filter((r) => r.id !== undefined).length) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve(out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
      }
    });
    child.on('error', reject);
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test('the server completes an MCP handshake and lists its tools', async () => {
  const [initialize, list] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(initialize.result.serverInfo.name, 'jev-dispatch');
  assert.ok(initialize.result.capabilities.tools);
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['delegate', 'dispatch_status']);
});

test('the main session is offered no way to choose a model, worker or tier', async () => {
  const [, list] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const delegate = list.result.tools.find((tool) => tool.name === 'delegate');
  const parameters = Object.keys(delegate.inputSchema.properties);

  // The whole contract: no capability knob exists to turn.
  assert.deepEqual(parameters.sort(), [
    'context', 'contextFiles', 'expectedOutput', 'riskFlags', 'task', 'taskType', 'verification',
  ]);
  assert.equal(delegate.inputSchema.additionalProperties, false);

  const surface = JSON.stringify(delegate).toLowerCase();
  for (const forbidden of ['haiku', 'sonnet', 'opus', 'claude-', 'anthropic', 'tier', 'cheap', 'frontier', 'jev']) {
    assert.ok(!surface.includes(forbidden), `"${forbidden}" is visible to the main session`);
  }
  // And it says so in words, so the model does not try anyway.
  assert.match(delegate.description, /Do not request a model, a worker, an effort level, or a quality setting/);
});

test('an empty task is rejected as a tool error, not a protocol error', async () => {
  const [, call] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { task: '   ' } } },
  ]);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /task is required/);
  assert.equal(call.error, undefined);
});

test('an unknown tool is a protocol error', async () => {
  const [, call] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
  ]);
  assert.equal(call.error.code, -32602);
});

test('status reports the experiment, and points at the local dashboard only', async () => {
  const [, call] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dispatch_status', arguments: {} } },
  ]);
  const status = call.result.structuredContent;
  assert.equal(status.routingMode, 'policy-graph');
  assert.equal(status.policyVersion, 'v1');
  assert.match(status.dashboard, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(typeof status.delegations, 'number');
});

test('a malformed frame does not take the server down', async () => {
  const [, list] = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    'not json at all',
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((entry) => (typeof entry === 'string' ? { raw: entry } : entry)).map((entry) => entry.raw ?? entry));
  assert.ok(list.result.tools.length > 0);
});
